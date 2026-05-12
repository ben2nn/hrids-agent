# 多智能体架构配置重构方案

## Context

此方案旨在将 `hrids-agent` 的配置系统从单一 JSON 演进为支持多智能体角色模板、YAML 配置格式、Markdown 角色定义的完整多智能体配置框架。

**当前问题**：
1. 所有子智能体共享同一个 provider/model，无法按角色分配不同模型
2. 子智能体的 systemPrompt 硬编码在代码中（`AgentTool.ts:41-43`、`AgentPool.ts:126`）
3. 工具排除列表硬编码（`AgentPool.ts:88`、`AgentTool.ts:92`）
4. 没有角色模板/AgentProfile 机制
5. 配置只有 JSON 格式，没有 YAML 支持

**目标配置目录结构**：
```
~/.hrids-agent/
├── config.yaml              # 主配置（YAML 优先，JSON 降级兼容）
├── config.json              # [兼容] 旧格式，YAML 不存在时降级读取
├── mcp.json                 # [已有] MCP 服务器配置
├── specialists/                # 全局 Agent Profile 目录
│   ├── code-reviewer.yaml
│   ├── test-runner.yaml
│   └── researcher.yaml
├── roles/                   # Markdown 角色模板目录
│   ├── code-reviewer.md
│   ├── test-runner.md
│   └── researcher.md
└── sessions/                # [已有] 会话数据
```

项目级覆盖（优先级高于全局）：
```
<project>/.hrids/
├── config.yaml              # 项目级配置覆盖
├── specialists/                # 项目级 Agent Profile
│   └── project-architect.yaml
└── roles/                   # 项目级角色模板
    └── project-architect.md
```

---

## 实施步骤

### P0 — 核心基础设施

#### Step 1: 新增 `js-yaml` 依赖并创建 YAML 配置加载器

**创建**: `src/core/YamlLoader.ts`
- 封装 `js-yaml` 的 `load()` 和 `dump()`，统一 UTF-8 处理
- `loadYamlFile(path: string): unknown` — 读取并解析 YAML
- `saveYamlFile(path: string, data: unknown): void` — 原子写入（tmp+rename）
- YAML 解析失败时抛出可读的错误信息（含行号）

**修改**: `package.json`
- 添加 `js-yaml` 及 `@types/js-yaml` 依赖

#### Step 2: 重构 Config.ts — YAML 优先 + JSON 降级

**修改**: `src/core/Config.ts`

核心改动：
1. 新增 `CONFIG_YAML_FILE` 常量指向 `config.yaml`
2. `loadConfigFile()` 优先级：`config.yaml` → `config.json` → 默认生成
3. 读到 JSON 时打印迁移提示：`[config] 检测到 config.json，建议迁移到 config.yaml（运行 hrids-agent init --migrate）`
4. `saveConfig()` 写入 YAML 格式（保持 `saveConfigToJson()` 用于向后兼容）
5. `normalize()` 保持不变（内部数据结构不变，只是序列化格式变化）

关键代码逻辑：
```typescript
function loadConfigFile(): Partial<AgentConfig> {
  // 1. 优先 YAML
  if (existsSync(CONFIG_YAML_FILE)) {
    return parseYaml(readFileSync(CONFIG_YAML_FILE, 'utf-8'))
  }
  // 2. 降级 JSON（打印迁移提示）
  if (existsSync(CONFIG_JSON_FILE)) {
    process.stderr.write('[config] 检测到 config.json，建议运行 hrids-agent init --migrate 迁移到 YAML\n')
    return JSON.parse(readFileSync(CONFIG_JSON_FILE, 'utf-8').replace(/^﻿/, ''))
  }
  // 3. 默认生成 YAML
  return generateDefault() // 生成后写入 config.yaml
}
```

#### Step 3: 定义 AgentProfile 接口

**创建**: `src/core/coordinator/AgentProfile.ts`

```typescript
export interface AgentProfile {
  name: string                          // 角色名称，如 "code-reviewer"
  description: string                   // 角色描述，供 coordinator 自动选择
  model?: string                        // 指定模型（不填则继承父 agent）
  provider?: string                     // 指定提供商
  apiKey?: string                       // 该角色的专属 API Key
  baseUrl?: string                      // 该角色的专属 Base URL
  systemPrompt?: string                 // 内联 system prompt（短描述）
  systemPromptFile?: string             // 引用外部 .md 文件路径
  allowedTools?: string[]               // 工具白名单
  maxTurns?: number                     // 默认最大轮数
  maxBudgetUsd?: number                 // 费用上限
  isolated?: boolean                    // 是否默认隔离工作目录
  autoSelectable?: boolean              // coordinator 可自动选择
  metadata?: Record<string, string>     // 模板变量（如 project_name, language）
}
```

#### Step 4: 创建 Agent Profile 加载器

**创建**: `src/core/coordinator/ProfileLoader.ts`

核心功能：
1. `loadProfiles(dirs: string[]): AgentProfile[]` — 从多个目录加载 profile
2. `resolveProfile(name: string): AgentProfile | undefined` — 按名查找
3. `listProfiles(): AgentProfile[]` — 列出所有可用 profile
4. `resolveSystemPrompt(profile: AgentProfile): string` — 解析 systemPrompt
   - 有 `systemPromptFile` → 读取 `.md` 文件
   - 有 `systemPrompt` → 直接使用
   - 两者都有 → systemPromptFile 优先
5. `applyTemplateVars(template: string, vars: Record<string, string>): string` — 替换 `{{变量}}`

Markdown 角色模板支持 Frontmatter：
```markdown
---
name: code-reviewer
description: 审查代码质量、安全性和最佳实践
model: claude-sonnet-4-20250514
provider: anthropic
maxTurns: 15
autoSelectable: true
---

# 代码审查专家

你是一个资深代码审查专家。审查代码时关注：

## 审查重点
1. **安全漏洞**：SQL 注入、XSS、命令注入、路径遍历
2. **性能问题**：N+1 查询、不必要的循环、内存泄漏
3. **可维护性**：命名规范、函数长度、模块耦合
4. **最佳实践**：错误处理、类型安全、测试覆盖

## 输出格式
使用结构化审查报告：
- 严重程度：[致命/严重/建议]
- 位置：文件:行号
- 问题描述
- 修复建议
```

#### Step 5: 新增 `multiAgent` 配置分组

**修改**: `src/core/Config.ts`

在 `AgentConfig` 中新增：
```typescript
export interface MultiAgentConfig {
  globalMaxConcurrent?: number          // 全局最大并发数（默认 10）
  defaultMaxTurns?: number              // 子智能体默认最大轮数（默认 30）
  defaultTimeoutMs?: number             // 默认超时 ms（默认 300000）
  defaultModel?: string                 // 子智能体默认模型
  defaultProvider?: string              // 子智能体默认提供商
  profiles?: AgentProfile[]             // 内联 profile 列表
  profileDirs?: string[]                // 额外扫描的 profile 目录
  autoSelectProfiles?: boolean          // 允许 coordinator 自动选择（默认 true）
  allowRecursiveAgent?: boolean         // 允许递归创建子智能体（默认 false）
}

export interface ToolPermissionPolicy {
  defaultDenyList?: string[]            // 默认排除的工具列表
  profileOverrides?: Record<string, string[]>  // 按 profile 额外允许的工具
  allowMcpTools?: boolean               // 子智能体是否可访问 MCP 工具（默认 false）
}
```

对应 YAML 示例：
```yaml
# ~/.hrids-agent/config.yaml
model: qwen-plus-2025-07-28

llm:
  fallbacks:
    - provider: aliyun
      models: [qwen-plus-2025-07-28, qwen-max-2025-01-25]
      apiKey: sk-xxx

agent:
  permissionMode: ask
  maxTokens: 8096
  maxTurns: 50

multiAgent:
  globalMaxConcurrent: 10
  defaultMaxTurns: 30
  defaultTimeoutMs: 300000
  autoSelectProfiles: true
  profiles:
    - name: quick-worker
      description: 执行简单快速的单步任务
      model: qwen-turbo-2025-04-28
      maxTurns: 5

toolPermissions:
  defaultDenyList:
    - todo_write
    - todo_update
    - todo_append
    - todo_reset
    - schedule_cron
  allowMcpTools: false
  profileOverrides:
    test-runner:
      - todo_write
      - todo_update

gateway:
  port: 3282
  host: 127.0.0.1

logging:
  level: info
  theme: default
```

独立的 Agent Profile 示例（`specialists/code-reviewer.yaml`）：
```yaml
name: code-reviewer
description: 审查代码质量、安全性和最佳实践
model: claude-sonnet-4-20250514
provider: anthropic
systemPromptFile: roles/code-reviewer.md
allowedTools:
  - read
  - glob
  - grep
  - bash
maxTurns: 15
isolated: false
autoSelectable: true
```

---

### P1 — 执行层适配

#### Step 6: AgentPool/AgentTool 适配 Profile

**修改**: `src/core/coordinator/AgentPool.ts`
- `submit()` 方法支持接收 `AgentProfile` 参数
- 有 profile 时用 profile 的 model/provider 创建独立 provider
- 工具排除列表从 `ToolPermissionPolicy` 读取，不再硬编码

**修改**: `src/tools/AgentTool.ts`
- `agent` 工具的 input schema 新增 `profile: z.string().optional()` 参数
- 传入 profile 名时从 ProfileLoader 查找配置
- 支持 `profile` 和手动 `prompt/system_prompt/allowed_tools` 组合

**修改**: `src/tools/TeamTools.ts`
- `agent_spawn` 工具新增 `profile` 参数
- `team_create` 支持 `profile` 预设（团队默认 profile）

#### Step 7: Coordinator Prompt 增强

**修改**: `src/core/coordinator/coordinatorPrompt.ts`
- `EXT_AGENT` 扩展块中补充 profile 选择指导
- 当 `autoSelectProfiles=true` 且有可用 profiles 时，coordinator 自动匹配角色
- Coordinator 能看到所有可用 profiles 的 name + description 清单

```typescript
// 在 EXT_AGENT 中注入可用的 profiles 清单
function buildAgentExtension(profiles: AgentProfile[]): PromptExtension {
  if (profiles.length === 0) return EXT_AGENT
  const profileList = profiles
    .filter(p => p.autoSelectable !== false)
    .map(p => ` - **${p.name}**: ${p.description}`)
    .join('\n')
  return {
    id: 'agent',
    content: EXT_AGENT.content + `\n\n可用智能体角色：\n${profileList}\n\n使用 agent 或 agent_spawn 工具时，传入 profile 参数指定角色。`,
  }
}
```

#### Step 8: main.ts 启动流程更新

**修改**: `src/main.ts`
- 初始化 `ProfileLoader`，加载全局 + 项目级 profiles
- 传给 `getCoordinatorSystemPrompt()` 用于注入可用 profiles
- 传给 `TeamManager.init()` 供运行时解析

---

### P2 — 体验优化

#### Step 9: init 命令更新

**修改**: `src/commands/init.ts`
- 生成 `config.yaml` 而非 `config.json`
- 新增 `--migrate` 参数：自动检测 JSON 配置并转换为 YAML
- 新增 `--with-profiles` 参数：同时生成示例 agent profiles
- 生成的配置带有注释（YAML 原生支持 `#`）

#### Step 10: 命令行参数补充

**修改**: `src/main.ts`
- 新增 `--profile <name>` 全局参数：为当前会话指定默认 agent profile
- 新增 `--list-profiles` 子命令：列出所有可用 profiles

---

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新增** | `src/core/YamlLoader.ts` | YAML 读/写工具 |
| **新增** | `src/core/coordinator/AgentProfile.ts` | AgentProfile 接口定义 |
| **新增** | `src/core/coordinator/ProfileLoader.ts` | Profile 加载/解析器 |
| **修改** | `src/core/Config.ts` | YAML 优先加载、multiAgent 分组、ToolPermissionPolicy |
| **修改** | `src/core/coordinator/AgentPool.ts` | Profile 驱动子智能体、工具权限从配置读取 |
| **修改** | `src/tools/AgentTool.ts` | 新增 profile 参数 |
| **修改** | `src/tools/TeamTools.ts` | agent_spawn/team_create 支持 profile |
| **修改** | `src/core/coordinator/coordinatorPrompt.ts` | EXT_AGENT 注入可用 profiles |
| **修改** | `src/main.ts` | ProfileLoader 初始化、新 CLI 参数 |
| **修改** | `src/commands/init.ts` | 生成 YAML、--migrate、--with-profiles |
| **修改** | `package.json` | 新增 js-yaml 依赖 |

## 不修改的文件

- `src/core/coordinator/TeamManager.ts` — 接口保持，内部调用 ProfileLoader
- `src/core/coordinator/MessageBus.ts` — 无变更
- `src/memory/` — 无变更
- `src/skills/` — 无变更

---

## 向后兼容策略

1. **配置读取**：YAML 优先 → JSON 降级 → 默认生成 YAML，旧用户无感知
2. **AgentConfig 接口**：新增字段全部 `?` 可选，旧代码不传不报错
3. **AgentPool/AgentTool**：不传 profile 时行为与之前完全一致
4. **工具排除**：不配 `toolPermissions.defaultDenyList` 时使用现有硬编码作为默认值
5. **saveConfig**：新增 `saveConfig(format?: 'yaml' | 'json')` 参数，旧调用默认 YAML
6. **mcp.json**：保持不变，不在本次重构范围内

---

## 验证方案

1. **单元测试**：
   - `YamlLoader` 读/写/错误处理
   - `ProfileLoader` 多目录加载、优先级合并、Markdown 解析
   - `Config.loadConfig()` YAML/JSON 降级逻辑
   - `applyTemplateVars()` 变量替换

2. **集成测试**：
   - 只有 `config.json` 时 → 正常加载 + 打印迁移提示
   - 只有 `config.yaml` 时 → 优先加载
   - 两者都有 → YAML 优先
   - `hrids-agent init` → 生成 YAML
   - `hrids-agent init --migrate` → JSON → YAML 迁移
   - `hrids-agent init --with-profiles` → 生成示例 profiles

3. **端到端测试**：
   - `hrids-agent --list-profiles` → 列出所有 profiles
   - `hrids-agent -p "审查 src/core/Config.ts" --profile code-reviewer` → 使用指定 profile
   - Coordinator 自动选择 profile 场景
   - Gateway 多会话 profile 隔离

4. **回归测试**：
   - 现有 JSON 配置用户无感知
   - 不传 profile 时子智能体行为不变
   - `--gateway` 模式正常
   - `--server` 模式正常
