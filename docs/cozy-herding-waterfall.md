# 多智能体架构实施方案

## 一、总体目标

1. **配置目录迁移**：`~/.hrids-agent` → `~/.hrids`
2. **主智能体自述文件**：在 `agents/main/` 下初始化 8 个 .md 文件 + agent.yaml
3. **提示词外置**：PromptLoader 从文件加载，文件不存在时回退到代码内置默认值
4. **记忆系统重构**：MEMORY.md 策略驱动 + 3 桶文件分桶 + SQLite 向量索引，替代 4 层宫殿隐喻堆栈
5. **Session 调整**：保持独立的 `sessions/` 目录（不合并到 agent 目录），增加 agent 归属字段
6. **Specialists + Roles 分离**：specialists/ = 精简 yaml-only，roles/ = 共享模板
7. **团队设计保留**：team_create/spawn/status/wait/send_message 全部保留不变
8. **工作流预留**：后续实现，目录结构预留

## 二、最终目录结构

```
~/.hrids/                              # 配置目录（由 ~/.hrids-agent 改名）
├── config.yaml                        # 全局配置（LLM 提供商、Gateway 等）
├── AGENT.md                           # 用户级全局记忆（已存在）
├── agents/
│   └── main/                          # 主智能体（唯一持久化且有数据的 agent）
│       ├── agent.yaml                 # 智能体配置（最小化，默认值驱动）
│       ├── IDENTITY.md                # 身份定位 → SECTION_INTRO
│       ├── SOUL.md                    # 行为准则 → SECTION_EXECUTION + ACTIONS + FILE_PATH
│       ├── BOOTSTRAP.md               # 任务规划 → SECTION_TODO + EXT_TASK
│       ├── TOOLS.md                   # 工具使用 → SECTION_TOOLS + EXT_SCRIPT/CRAWL/CODE/FILE
│       ├── USER.md                    # 用户交互 → SECTION_DECISION + OUTPUT + COREFERENCE
│       ├── AGENTS.md                  # 多智能体协作 → EXT_AGENT + profiles 参考
│       ├── MEMORY.md                  # 记忆策略（用户可编辑）
│       ├── HEARTBEAT.md               # 心跳/续接（预留，后续完善）
│       ├── permission-rules.json      # 运行时权限状态（动态规则）
│       ├── memory/                    # 记忆数据目录（3 桶模型）
│       │   ├── facts.jsonl            # 事实性记忆（增量追加）
│       │   ├── preferences.jsonl      # 用户偏好（覆盖更新）
│       │   ├── decisions.jsonl        # 技术决策历史
│       │   └── index.db               # SQLite 向量索引（语义检索）
├── specialists/                       # 专家：精简 yaml-only，无数据目录
│   ├── code-reviewer.yaml             # 引用 roles/code-reviewer.md
│   ├── security-auditor.yaml
│   └── data-analyst.yaml
├── roles/                             # 共享模板（frontmatter 配置 + markdown 正文）
│   ├── code-reviewer.md
│   └── security-auditor.md
└── sessions/                          # 会话持久化（独立于 agent，按 sessionId 隔离）
    └── {sessionId}/
        ├── transcript.jsonl
        ├── meta.json
        └── archives.json
```

### 概念关系

| 概念 | 目录 | 有 8 个 .md 文件？ | 有 memory/？ | 有 sessions/？ | 配置格式 |
|---------|-----|:---:|:---:|:---:|---------------|
| **主智能体** | `agents/main/` | 是 | 是 | 否（sessions 独立） | `agent.yaml` |
| **专家** | `specialists/xxx.yaml` | 否 | 否 | 否 | 单个 `.yaml` 文件 |
| **角色模板** | `roles/xxx.md` | N/A | N/A | N/A | YAML frontmatter + markdown 正文 |

### agent.yaml Schema（最小化——默认值驱动）

系统为每个字段提供内置默认值。用户只需定义需要覆盖的字段。空的或缺失的 `agent.yaml` 完全有效。

```yaml
# agents/main/agent.yaml
# 所有字段均可选 —— 默认值来自 config.yaml + 代码内置值

# 覆盖全局 LLM 设置（取消注释即可使用）
# model: claude-3-5-sonnet-20241022
# provider: anthropic

# 覆盖智能体行为（取消注释即可使用）
# maxTurns: 50
# maxBudgetUsd: 10.0

# 覆盖权限默认值（取消注释即可使用）
# permission:
#   mode: ask
#   denied_paths: [.env, secrets/]
#   always_deny: ["bash(rm *)", "bash(shutdown)"]

# 限制工具（空 = 全部允许，排除 deny list）
# allowed_tools: []
```

**默认值策略**：

| 字段 | 默认值来源 |
|-------|---------------|
| `model` / `provider` | `config.yaml llm.fallbacks[0]` |
| `maxTurns` | `config.yaml agent.maxTurns` (50) |
| `maxBudgetUsd` | `config.yaml agent.maxBudgetUsd`（不限制） |
| `permission.mode` | `config.yaml agent.permissionMode` (ask) |
| `allowed_tools` | 所有工具减去 `config.yaml toolPermissions.defaultDenyList` |
| `multiAgent.profileDirs` | 自动包含 `~/.hrids/specialists/` |

### config.yaml 中 multiAgent.profiles 的变更

**当前** `config.yaml`：
```yaml
multiAgent:
  profiles:           # 内联 profiles（嵌入在 config 中）
    - name: code-reviewer
      description: ...
      allowed_tools: [...]
  profileDirs: []
```

**新设计** — `multiAgent.profiles` 已弃用，改为 `specialists/` 目录：

```yaml
multiAgent:
  # profiles: []         # 已弃用：使用 specialists/ 目录替代
  profileDirs:
    - ~/.hrids/specialists/    # init 自动添加
  autoSelectProfiles: true
  allowRecursiveAgent: false
  globalMaxConcurrent: 10
  defaultMaxTurns: 30
  defaultTimeoutMs: 300000
```

**迁移策略**：`loadConfig()` 仍读取旧的 `multiAgent.profiles` 但输出弃用警告。`listProfiles()` 优先从 `specialists/` 加载，回退到内联 profiles 以保持向后兼容。

### Specialist yaml 中 role 字段的加载逻辑

**当前 `ProfileLoader.ts`**（`loadProfileFromYaml()`）支持：
- `systemPrompt` - 内联提示词文本
- `systemPromptFile` - 指向 `.md` 文件的相对/绝对路径

**新增 `role` 字段**：

```typescript
// specialist yaml: role 字段引用 roles/ 模板
// ProfileLoader.ts loadProfileFromYaml() — 新增逻辑：
if (raw.role) {
  // "role: roles/code-reviewer.md" → 相对于 ~/.hrids/ 解析
  // 同时检查相对于全局 roles 目录
  const globalRolePath = join(GLOBAL_ROLES_DIR, raw.role.replace(/^roles\//, ''))

  if (existsSync(globalRolePath)) {
    const { frontmatter, body } = parseFrontmatter(readFileSync(globalRolePath, 'utf-8'))
    // 合并 frontmatter 作为默认值（specialist yaml 覆盖）
    profile.systemPrompt = body
    profile.allowedTools = raw.allowed_tools ?? frontmatter.allowedTools
    profile.description = raw.description ?? frontmatter.description
  }
}
```

**专家加载优先级**：
1. `specialists/xxx.yaml` 字段（最高优先级）
2. `roles/xxx.md` YAML frontmatter（作为默认值合并）
3. `roles/xxx.md` markdown 正文 → 成为 `systemPrompt`
4. 代码内置默认值（回退）

### 专家 yaml 示例（`specialists/code-reviewer.yaml`）：
```yaml
name: code-reviewer
description: 审查代码质量、安全性和最佳实践
role: roles/code-reviewer.md       # 引用共享模板
model: claude-3-5-haiku-20241022   # 专家可用更便宜的模型
allowed_tools: [file_read, grep, glob]
maxTurns: 15
autoSelectable: true
```

### 角色模板示例（`roles/code-reviewer.md`）：
```markdown
---
name: code-reviewer
description: 审查代码质量、安全性和最佳实践
tags: [code, review, quality]
allowed_tools: [file_read, grep, glob, bash]
maxTurns: 15
autoSelectable: true
---

# 代码审查专家
你是一个资深代码审查专家。审查代码时关注...
```

专家是按需派生的临时实例，继承主智能体的记忆上下文，无需持久化数据目录。

### Session 设计：保持独立，不合并到 agent 目录

经过对 Gateway 多会话模式的分析，sessions 应保持独立的 `~/.hrids/sessions/` 平铺目录结构，而不是合并到 `agents/main/sessions/`。

**原因**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 合并到 `agents/main/sessions/` | agent 数据自包含 | Gateway 多用户场景：所有用户共享同一 `main/` session 目录，存在跨用户污染风险 |
| 保持独立 `sessions/`（当前） | Gateway 多用户天然隔离，ephemeral- 子会话易清理 | session 与 agent 目录解耦 |

**结论**：保持当前 `~/.hrids/sessions/` 平铺结构，在 `SessionMeta` 中增加 `agent` 字段做归属标识。

```typescript
interface SessionMeta {
  id: string
  // ... 现有字段
  agent?: string            // 归属的智能体名称（main / code-reviewer / ...）
}
```

### 权限规则 3 层模型

```
agents/main/
├── agent.yaml                      # 静态默认值：初始权限配置
│   └── permission:
│       mode: ask
│       denied_paths: [.env, secrets/]
│
├── permission-rules.json           # 运行时动态状态（approvePermanent 写入）
│   └── { alwaysAllow: ["bash(git *)", ...], ... }
│
└── PermissionManager（进程内存）
    └── sessionApproved（会话内临时批准）
```

**三层合并逻辑**（`PermissionManager` 启动时）：

```
agent.yaml（静态默认值）
    ↓ 被覆盖
permission-rules.json（运行动态，approvePermanent 写入）
    ↓ 最低优先级
sessionApproved（内存，会话内临时）
```

### init 命令（简化——单条命令，无需 flags）

```bash
hrids-agent init
# 一次性创建所有内容：
#   ~/.hrids/config.yaml              （完整注释模板——所有选项可见）
#   ~/.hrids/agents/main/agent.yaml   （完整注释模板——所有选项可见）
#   ~/.hrids/agents/main/             （8 个 .md 文件）
#   ~/.hrids/specialists/             （code-reviewer.yaml、security-auditor.yaml、data-analyst.yaml）
#   ~/.hrids/roles/                   （code-reviewer.md、security-auditor.md）
#   ~/.hrids/agents/main/memory/      （空目录）
#   ~/.hrids/sessions/               （空目录）
```

`config.yaml` 和 `agent.yaml` 都生成为 **完整注释模板**，展示每个可用选项及其默认值。用户只需取消注释并修改需要的部分。这作为配置 schema 的活文档。

`--force` 保留用于强制覆盖已有配置。`--migrate` 保留用于 config.json → config.yaml 迁移。`--with-prompts` 和 `--with-profiles` 标志已移除。

### FallbackProvider 精简

**当前 251 行** → **精简后 ~80 行**。移除内容：
- `CircuitBreaker` 类（进程内熔断，重试逻辑由 `src/core/retry.ts` 处理）
- `ProviderGroup` 抽象（99% 的配置只有一组）
- `localGroupIdx`/`localModelIdx` 并发安全拷贝
- 空响应检测和预内容缓冲
- 熔断跳过循环

Fallback 配置由 `config.yaml` 提供默认值，无需 `fallback.json`。

```typescript
// 精简版 FallbackProvider（~80 行）
class FallbackProvider {
  stream(...) {
    for (const provider of this.providers) {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          for await (const chunk of provider.stream(...)) {
            yield chunk
          }
          return // 成功
        } catch (err) {
          if (attempt === this.maxRetries) break // 下一个 provider
          await sleep(1000 * attempt)
        }
      }
    }
    throw new Error("所有提供商均失败")
  }
}
```

## 三、实施步骤

### 步骤 1：配置目录迁移 `~/.hrids-agent` → `~/.hrids`

**涉及文件**：
- `src/core/Config.ts`：修改 `getConfigDir()` 返回 `~/.hrids`
- `src/core/SessionStore.ts:19`：`SESSIONS_DIR` 路径更新
- `src/memory/store.ts:12`：`STORE_DIR` 路径更新（步骤 4 进一步改造）
- `src/core/PermissionManager.ts:25`：`RULES_FILE` 路径更新
- `src/core/ContextBuilder.ts`：`findMemoryFiles` 路径引用
- `src/core/coordinator/ProfileLoader.ts`：`GLOBAL_AGENTS_DIR`、`GLOBAL_ROLES_DIR` 路径
- `src/commands/init.ts`：`CONFIG_DIR` 和相关路径
- `src/main.ts`：`join(homedir(), '.hrids-agent')` 引用

**迁移策略**：启动时自动检测 `~/.hrids-agent` → `~/.hrids` 迁移（旧目录存在且新目录不存在时自动重命名）。按全新项目处理，直接覆盖。

### 步骤 2：新建 `PromptLoader.ts` + 修改 `coordinatorPrompt.ts`

**新建 `src/core/coordinator/PromptLoader.ts`**：

```typescript
// getMainAgentDir() → ~/.hrids/agents/main/
// loadPromptFile(name) → 读取 {name}.md 内容，不存在返回 null
// hasMainAgentConfig() → 检查 agents/main/ 是否已初始化
```

**修改 `src/core/coordinator/coordinatorPrompt.ts`**：

在 `getCoordinatorSystemPrompt()` 中：
- 静态层 9 个 section → 合并为按文件加载的 5 个：
  - `IDENTITY.md` → 替换 SECTION_INTRO
  - `SOUL.md` → 替换 SECTION_EXECUTION + ACTIONS + FILE_PATH（合并）
  - `BOOTSTRAP.md` → 替换 SECTION_TODO
  - `TOOLS.md` → 替换 SECTION_TOOLS
  - `USER.md` → 替换 SECTION_DECISION + OUTPUT + COREFERENCE
- 扩展层 → 始终静态加载 3 个（不再依赖 classifyTask）：
  - `AGENTS.md` → 替换 EXT_AGENT
  - `MEMORY.md` → 替换 EXT_MEMORY
  - `HEARTBEAT.md` → 新增独立 section
- 工具速查层保持动态生成
- 所有默认值保留在代码中作为回退

导出 `DEFAULT_MAIN_AGENT_FILES: Record<string, string>` 供 init 使用。

**STATIC_SECTION_COUNT 更新**：合并后静态 section = 8 个（IDENTITY/SOUL/BOOTSTRAP/TOOLS/USER/AGENTS/MEMORY/HEARTBEAT），同步更新 `AnthropicProvider.ts`。

### 步骤 3：修改 `init.ts` — 统一为 `init` 命令

- 创建 `~/.hrids/agents/main/` 目录
- 写入 8 个 .md 文件 + `agent.yaml`，内容从 `DEFAULT_MAIN_AGENT_FILES` 获取
- 生成完整注释版本的 `config.yaml` 和 `agent.yaml`
- 创建 `specialists/` 目录和示例 yaml 文件
- 创建 `roles/` 目录和示例角色模板
- 处理旧目录迁移（见上方迁移逻辑）

### 步骤 4：记忆系统重构

**核心改动**：放弃 `src/memory/store.ts` 4 层宫殿隐喻（wing/room/drawer/L0-L3），改为 MEMORY.md 策略驱动 + 3 文件桶 + SQLite 向量索引。

**涉及文件**：

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/memory/store.ts` | **重写** | 3 文件桶（facts/preferences/decisions jsonl）+ SQLite 向量索引 |
| `src/memory/types.ts` | **修改** | 去掉 wing/room，新增 `agent`、`updatedAt` 字段 |
| `src/memory/layers.ts` | **废弃或简化** | L0 identity 由 IDENTITY.md 替代；L1 由启动时读取 facts/preferences 最近 20 条替代；L2 去掉；L3 保留语义搜索 |
| `src/memory/extractor.ts` | **修改** | 按 MEMORY.md 策略决定是否写入、写入哪个桶 |
| `src/memory/pipeline.ts` | **修改** | 简化为更轻量的后处理 |
| `agents/main/MEMORY.md` | **新建** | 默认记忆策略文件（步骤 3 中由 init 生成） |

**新 Memory 数据模型**：

```typescript
interface Memory {
  id: string
  content: string
  type: 'fact' | 'preference' | 'decision' | 'milestone' | 'problem'
  agent: string             // 来源智能体（main / code-reviewer / ...）
  importance: number        // 1-5
  createdAt: string
  updatedAt: string
  sourceSession?: string
  supersededBy?: string
}
```

**3 桶模型替代 L0-L3**：

| 层 | 旧 | 新 | Token 预算 |
|---|-----|-----|-------------|
| 身份 | L0 identity 表 | 直接注入 IDENTITY.md 内容（PromptLoader 已加载） | ~100 |
| 上下文 | L1 时间衰减排序 + L2 wing/room 过滤 | 启动时读取 facts/preferences 最近 20 条 | ~500 |
| 检索 | L3 向量搜索 | SQLite 向量索引按需检索 | 不限 |

### 步骤 5：Session 保持独立 + 增加 agent 归属

**修改 `src/core/SessionStore.ts`**：
- `SESSIONS_DIR` → `~/.hrids/sessions/`（独立于 agent 目录）
- SessionMeta 新增 `agent` 字段
- `listSessions()` 过滤 ephemeral- 前缀子会话保持不变

**修改 `src/bootstrap/setupSession.ts`**：session 创建时自动标记 `agent: 'main'`。

**修改 `src/tools/AgentTool.ts` + `src/core/coordinator/AgentPool.ts`**：子智能体临时 session 前缀 → `ephemeral-{agentName}-{id}`。

### 步骤 6：修改 `main.ts` — 启动检查

```typescript
if (!hasMainAgentConfig()) {
  console.warn('⚠ 主智能体提示词未初始化，使用内置默认值。')
  console.warn('  运行 hrids-agent init 生成可编辑文件')
}
```

## 四、涉及文件总表

| 优先级 | 文件 | 操作 |
|--------|------|------|
| P0 | `src/core/Config.ts` | 修改 getConfigDir() 路径 |
| P0 | `src/core/coordinator/PromptLoader.ts` | **新建** |
| P0 | `src/core/coordinator/coordinatorPrompt.ts` | 修改 |
| P0 | `src/core/providers/AnthropicProvider.ts` | 修改 STATIC_SECTION_COUNT |
| P0 | `src/commands/init.ts` | 修改：统一下 init 命令 |
| P0 | `src/main.ts` | 修改：启动检查 + 迁移 |
| P0 | `src/memory/store.ts` | **重写**：3 桶文件模型 + 向量索引 |
| P0 | `src/memory/types.ts` | 修改：去掉 wing/room，新增 agent 等 |
| P0 | `src/core/PermissionManager.ts` | 修改：RULES_FILE 路径 |
| P0 | `src/core/providers/FallbackProvider.ts` | 修改：精简 251→80 行 |
| P1 | `src/memory/layers.ts` | 简化：去掉 L0-L2 宫殿隐喻 |
| P1 | `src/memory/extractor.ts` | 修改：MEMORY.md 策略驱动 |
| P1 | `src/memory/pipeline.ts` | 修改：简化后处理 |
| P1 | `src/core/SessionStore.ts` | 修改：保持独立 sessions/ + 新增 agent 字段 |
| P1 | `src/bootstrap/setupSession.ts` | 修改：标记 agent='main' |
| P1 | `src/core/ContextBuilder.ts` | 修改：路径引用更新 |
| P1 | `src/core/coordinator/ProfileLoader.ts` | 修改：新增 `role` 字段支持 + specialists/ 加载 + 路径更新 |
| P1 | `src/tools/AgentTool.ts` | 修改：session 前缀 + specialists 加载 |
| P1 | `src/core/coordinator/AgentPool.ts` | 修改：session 前缀 |
| P2 | `src/gateway/SessionManager.ts` | 修改：路径引用更新（如有） |

## 五、测试策略

| 优先级 | 测试文件 | 操作 | 覆盖内容 |
|--------|---------|------|------|
| P0 | `tests/unit/Config.test.ts` | **修改** | 验证 `getConfigDir()` 返回 `~/.hrids` |
| P0 | `tests/unit/PromptLoader.test.ts` | **新建** | 文件存在/不存在/部分加载 |
| P0 | `tests/unit/coordinatorPrompt.test.ts` | **新建** | 8 文件到 section 映射、回退到默认值、STATIC_SECTION_COUNT |
| P0 | `tests/unit/MemoryStore.test.ts` | **新建** | 3 桶读写、向量搜索、agent 隔离 |
| P1 | `tests/unit/PermissionManager.test.ts` | **修改** | 更新 `RULES_FILE` 路径 |
| P1 | `tests/unit/init.test.ts` | **新建** | `init` 单条命令生成所有目录 |
| P2 | `tests/unit/GatewaySession.test.ts` | **新建** | Gateway 多会话 + agent 字段归属 |

## 六、验证方式

1. **路径迁移**：删除 `~/.hrids/`，启动 agent → 自动迁移，功能正常
2. **init 命令**：生成 agents/main/（8 个 .md + agent.yaml）+ specialists/ + roles/ + memory/ + sessions/ 目录，内容正确
3. **提示词覆盖**：修改 IDENTITY.md 后重启 → 修改生效
4. **记忆系统**：写入记忆 → 文件分桶正确 → 语义检索命中 → 启动时注入上下文
5. **多智能体隔离**：主智能体记忆在 `agents/main/memory/`，专家引用 roles/ 模板无持久化数据
6. **专家派生**：`agent(profile="code-reviewer")` → 从 `specialists/code-reviewer.yaml` 加载，通过 `role: roles/code-reviewer.md` 解析
7. **向后兼容**：旧 `multiAgent.profiles` 仍可用（弃用警告）；Gateway 多会话正常
8. **编译通过**：`tsc` 无错误，Gateway 模式正常
9. **权限规则**：`permission-rules.json` 位于 `agents/main/`，`PermissionManager` 从新路径读取
10. **FallbackProvider**：精简后多 LLM 故障转移正常，config.yaml 提供默认配置
