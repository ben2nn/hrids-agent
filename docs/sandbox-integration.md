# 沙盒集成指南

基于 `@anthropic-ai/sandbox-runtime` 为 agent 的命令执行提供 OS 级隔离，防止越界文件操作和网络访问。

---

## 目录

- [原理概述](#原理概述)
- [平台支持](#平台支持)
- [安装依赖](#安装依赖)
- [配置说明](#配置说明)
- [实现步骤](#实现步骤)
- [常见问题](#常见问题)

---

## 原理概述

沙盒通过 OS 原生机制隔离 agent 执行的 shell 命令：

- **macOS**：使用内置的 `sandbox-exec`（Seatbelt），无需额外安装
- **Linux / WSL2**：使用 `bubblewrap` 容器化 + `socat` 代理网络

每次 BashTool 执行命令前，先通过 `SandboxManager.wrapWithSandbox(command)` 将命令包装进受限环境，内核层面拒绝越界操作，不依赖正则黑名单。

```
LLM 生成命令
    ↓
BashTool.execute()
    ↓
SandboxManager.wrapWithSandbox(command)   ← 包装成受限命令
    ↓
spawn(sandboxedCommand)                    ← 内核级隔离执行
    ↓
越界操作 → EPERM（内核直接拒绝）
```

---

## 平台支持

| 平台 | 支持 | 沙盒技术 | 额外依赖 |
|------|------|---------|---------|
| macOS | ✅ | sandbox-exec（内置） | 仅需 ripgrep |
| Linux | ✅ | bubblewrap + socat | bubblewrap、socat、ripgrep |
| WSL2 | ✅ | bubblewrap + socat | 同 Linux |
| WSL1 | ❌ | 不支持 | — |
| Windows 原生 | ❌ | 不支持 | — |

---

## 安装依赖

### 1. 安装 npm 包

```bash
npm install @anthropic-ai/sandbox-runtime
```

> **注意**：这是 Research Preview，API 可能变化，建议锁定版本：
> ```bash
> npm install @anthropic-ai/sandbox-runtime@x.x.x
> ```

### 2. 安装系统依赖（Linux / WSL2）

```bash
# Ubuntu / Debian
sudo apt install bubblewrap socat ripgrep

# Fedora
sudo dnf install bubblewrap socat ripgrep

# Arch
sudo pacman -S bubblewrap socat ripgrep
```

### 3. Ubuntu 24.04+ 额外配置

Ubuntu 24.04 默认启用了 AppArmor 对 user namespace 的限制，会导致 bubblewrap 失败。需要关闭该限制：

```bash
# 临时生效（重启后失效）
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

# 永久生效
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-sandbox.conf
sudo sysctl -p /etc/sysctl.d/99-sandbox.conf
```

### 4. macOS

```bash
brew install ripgrep
```

---

## 配置说明

在 `~/.hrids-agent/config.json` 中添加 `sandbox` 字段：

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.config/gcloud"],
      "allowWrite": [],
      "denyWrite": [".env", ".env.local", ".env.production"]
    },
    "network": {
      "allowedDomains": []
    }
  }
}
```

### 字段说明

#### `sandbox.enabled`

| 值 | 说明 |
|----|------|
| `true` | 启用沙盒（平台不支持时降级为警告，不报错） |
| `false`（默认） | 不启用沙盒 |

#### `sandbox.filesystem` — 文件系统限制

**读限制（deny-then-allow 模式）**：默认允许读取所有路径，通过 `denyRead` 屏蔽敏感目录。

| 字段 | 类型 | 说明 |
|------|------|------|
| `denyRead` | `string[]` | 禁止读取的路径列表 |
| `allowRead` | `string[]` | 在 denyRead 范围内重新开放的路径（优先级高于 denyRead） |

**写限制（allow-only 模式）**：默认禁止写入所有路径，通过 `allowWrite` 显式开放。

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowWrite` | `string[]` | 允许写入的路径（留空时由代码自动填入 sessionCwd 和 /tmp） |
| `denyWrite` | `string[]` | 在 allowWrite 范围内禁止写入的路径（优先级高于 allowWrite） |

> **注意（Linux）**：Linux 上路径不支持 glob，只能使用字面路径。macOS 支持 `src/**/*.ts` 这类 glob。

#### `sandbox.network` — 网络限制

网络采用 **allow-only 模式**，默认封锁所有出站连接。

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowedDomains` | `string[]` | 允许访问的域名（支持通配符 `*.example.com`） |
| `deniedDomains` | `string[]` | 明确禁止的域名（优先级高于 allowedDomains） |

> **重要**：网络沙盒会导致 `npm install`、`pip install`、`curl` 等命令失败，除非在 `allowedDomains` 中预先开放对应域名。**建议初期只启用文件系统沙盒，不配置网络限制。**

---

## 实现步骤

### 第一步：在 Config 中添加 sandbox 字段

编辑 `src/core/Config.ts`，在 `AgentConfig` 接口中添加：

```typescript
// 在 AgentConfig 接口中添加
sandbox?: {
  enabled?: boolean
  filesystem?: {
    denyRead?: string[]
    allowRead?: string[]
    allowWrite?: string[]
    denyWrite?: string[]
  }
  network?: {
    allowedDomains?: string[]
    deniedDomains?: string[]
  }
}
```

### 第二步：创建 SandboxService

新建 `src/core/SandboxService.ts`：

```typescript
import { logger } from './logger.js'
import { loadConfig } from './Config.js'

const log = logger.child({ component: 'sandbox' })

let sandboxManager: typeof import('@anthropic-ai/sandbox-runtime').SandboxManager | null = null
let initialized = false
let initPromise: Promise<void> | null = null

/**
 * 懒加载 sandbox-runtime，包不存在时静默降级
 */
async function getSandboxManager() {
  if (sandboxManager !== null) return sandboxManager
  try {
    const mod = await import('@anthropic-ai/sandbox-runtime')
    sandboxManager = mod.SandboxManager
    return sandboxManager
  } catch {
    log.debug('sandbox-runtime 不可用，沙盒功能已禁用')
    return null
  }
}

/**
 * 初始化沙盒（在 SessionManager.createSession 中调用一次）
 * sessionCwd：会话工作目录，自动加入 allowWrite
 */
export async function initSandbox(sessionCwd: string): Promise<void> {
  if (initPromise) return initPromise
  initPromise = _doInit(sessionCwd)
  return initPromise
}

async function _doInit(sessionCwd: string): Promise<void> {
  const config = loadConfig()
  if (!config.sandbox?.enabled) return

  const mgr = await getSandboxManager()
  if (!mgr) {
    log.warn('sandbox.enabled=true 但 @anthropic-ai/sandbox-runtime 未安装，沙盒已跳过')
    log.warn('请执行: npm install @anthropic-ai/sandbox-runtime')
    return
  }

  // 检测平台依赖
  const depCheck = mgr.checkDependencies()
  if (depCheck.errors.length > 0) {
    log.warn('沙盒依赖缺失，沙盒已跳过', { errors: depCheck.errors })
    log.warn('Linux/WSL2 请执行: sudo apt install bubblewrap socat ripgrep')
    return
  }
  if (depCheck.warnings.length > 0) {
    log.warn('沙盒依赖警告（seccomp 未安装，Unix socket 隔离不完整）', { warnings: depCheck.warnings })
  }

  // 构建文件系统配置
  // allowWrite 自动包含 sessionCwd 和 /tmp，确保 agent 正常工作
  const fsConfig = config.sandbox.filesystem ?? {}
  const allowWrite = [
    sessionCwd,
    '/tmp',
    ...(fsConfig.allowWrite ?? []),
  ]

  const runtimeConfig = {
    filesystem: {
      denyRead: fsConfig.denyRead ?? ['~/.ssh', '~/.aws'],
      allowRead: fsConfig.allowRead ?? [],
      allowWrite,
      denyWrite: fsConfig.denyWrite ?? ['.env', '.env.local'],
    },
    network: config.sandbox.network
      ? {
          allowedDomains: config.sandbox.network.allowedDomains ?? [],
          deniedDomains: config.sandbox.network.deniedDomains ?? [],
        }
      : undefined,
  }

  try {
    await mgr.initialize(runtimeConfig)
    initialized = true
    log.info('沙盒已启动', {
      allowWrite,
      denyRead: runtimeConfig.filesystem.denyRead,
      networkEnabled: !!config.sandbox.network,
    })
  } catch (err) {
    log.warn('沙盒初始化失败，降级为无沙盒模式', { error: String(err) })
  }
}

/**
 * 将命令包装进沙盒（BashTool 调用）
 * 沙盒未启用或初始化失败时，原样返回命令
 */
export async function wrapCommandWithSandbox(command: string): Promise<string> {
  if (!initialized) return command

  const mgr = await getSandboxManager()
  if (!mgr) return command

  try {
    return await mgr.wrapWithSandbox(command)
  } catch (err) {
    log.warn('沙盒包装失败，使用原始命令', { error: String(err) })
    return command
  }
}

/**
 * 检查沙盒是否已启用并正常运行
 */
export function isSandboxActive(): boolean {
  return initialized
}

/**
 * 重置沙盒（会话销毁时调用）
 */
export async function resetSandbox(): Promise<void> {
  if (!initialized) return
  const mgr = await getSandboxManager()
  if (!mgr) return
  try {
    await mgr.reset()
  } catch { /* 忽略 */ }
  initialized = false
  initPromise = null
}
```

### 第三步：修改 BashTool

在 `src/tools/BashTool.ts` 的 `execute` 方法中，在 `spawn` 之前加入沙盒包装：

```typescript
// 在文件顶部添加导入
import { wrapCommandWithSandbox, isSandboxActive } from '../core/SandboxService.js'

// 在 execute 方法中，spawn 之前添加：
async execute(input, ctx?: ToolContext) {
  // ... 现有代码 ...

  // 沙盒包装：将命令包装进受限环境（沙盒未启用时原样返回）
  const commandToRun = await wrapCommandWithSandbox(input.command)
  if (isSandboxActive() && commandToRun !== input.command) {
    logLine(`[bash] 沙盒模式已启用`)
  }

  // 将原来的 input.command 替换为 commandToRun
  const child = spawn('/bin/sh', ['-c', commandToRun], {
    cwd,
    // ... 其余不变
  })
```

### 第四步：在 SessionManager 中初始化沙盒

在 `src/gateway/SessionManager.ts` 的 `createSession` 方法末尾，`engine` 创建之后添加：

```typescript
import { initSandbox, resetSandbox } from '../core/SandboxService.js'

// createSession 末尾，return session 之前：
await initSandbox(sessionCwd)

// destroySession 中，sessions.delete 之前：
await resetSandbox()
```

### 第五步：CLI 模式同样初始化

在 `src/main.ts` 中，QueryEngine 创建之后添加：

```typescript
import { initSandbox } from './core/SandboxService.js'

// 在 QueryEngine 初始化之后：
const agentCwd = config.agentCwd ?? getDefaultAgentCwd()
await initSandbox(agentCwd)
```

---

## 常见问题

### agent 执行命令时报 `Operation not permitted`

沙盒的写权限是 allow-only，只有 `sessionCwd` 和 `/tmp` 默认可写。如果 agent 需要写入其他目录，在配置中添加：

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "allowWrite": ["/home/user/projects"]
    }
  }
}
```

### `npm install` / `pip install` 失败

网络沙盒默认封锁所有出站连接。有两个解决方案：

**方案 A（推荐）**：不配置 `network` 字段，只启用文件系统沙盒：

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": { "denyRead": ["~/.ssh"] }
  }
}
```

**方案 B**：在 `allowedDomains` 中开放所需域名：

```json
{
  "sandbox": {
    "network": {
      "allowedDomains": [
        "registry.npmjs.org", "*.npmjs.org",
        "pypi.org", "files.pythonhosted.org",
        "github.com", "*.github.com",
        "raw.githubusercontent.com"
      ]
    }
  }
}
```

### Ubuntu 24.04 上 bubblewrap 报错

```
bwrap: Creating new namespace failed: Permission denied
```

执行：

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

### WSL1 不支持沙盒

WSL1 内核不支持 user namespace，无法使用 bubblewrap。需要升级到 WSL2：

```powershell
wsl --set-version <distro-name> 2
```

### 沙盒启用后 `cd` 命令行为异常

BashTool 内部拦截了 `cd` 命令并更新 `globalCwd`，沙盒包装在 `cd` 拦截之后执行，不影响目录切换逻辑。如果遇到问题，检查 `cd` 拦截逻辑是否在 `wrapCommandWithSandbox` 之前执行。

### 检查沙盒是否正常运行

在 agent 中执行：

```bash
# 测试文件系统限制（应该报错）
cat ~/.ssh/id_rsa

# 测试工作目录可写（应该成功）
echo "test" > test.txt && rm test.txt
```

---

## 推荐配置

### 最小安全配置（只保护敏感文件，不影响 agent 工作）

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.config/gcloud", "~/.kube"],
      "denyWrite": [".env", ".env.local", ".env.production", ".env.bak"]
    }
  }
}
```

### 严格配置（限制网络 + 文件系统，适合不信任的任务）

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "/etc/passwd", "/etc/shadow"],
      "denyWrite": [".env", "secrets/"]
    },
    "network": {
      "allowedDomains": [
        "registry.npmjs.org",
        "pypi.org",
        "github.com", "*.github.com",
        "raw.githubusercontent.com"
      ]
    }
  }
}
```

---

## 注意事项

1. **Research Preview**：`@anthropic-ai/sandbox-runtime` 是早期预览版，API 可能变化，建议锁定版本后再升级。

2. **Linux glob 不支持**：Linux 上 `allowWrite`、`denyRead` 等路径只能使用字面路径，不支持 `*` 通配符。macOS 支持 glob。

3. **网络代理绕过**：Linux 上网络限制通过环境变量 `HTTP_PROXY` 注入，不遵守该变量的程序（部分 Go 程序、直接使用 socket 的程序）可以绕过。macOS 的 seatbelt 是内核级的，没有此问题。

4. **沙盒失败降级**：`SandboxService` 的所有错误都会降级为无沙盒模式，不会导致 agent 崩溃。生产环境如需强制沙盒，可在 `_doInit` 中将 `log.warn` 改为 `throw`。
