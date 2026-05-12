# ToolRegistry 接入 QueryEngine 重构方案

**日期**: 2026-05-12
**状态**: 已完成

## 一、目标

将 ToolRegistry 作为工具管理层接入 QueryEngine，消除两套工具管理逻辑的重叠。

## 二、职责划分

```
ToolRegistry（管理层）          QueryEngine（执行层）
├─ 工具存储（Map, O(1) 查找）    ├─ 流式执行（AsyncGenerator）
├─ 动态注册/注销（MCP 热插拔）   ├─ 超时/abort 控制
├─ plan-mode 工具标注            ├─ 权限检查（PermissionManager）
├─ autoFlatten schema           ├─ Zod 校验 + 自动修复
├─ 拦截器（setToolInterceptor）  ├─ 风暴检测（StormBreaker）
├─ 审计监听（setAuditListener）  ├─ 并发调度（partitionToolCalls）
└─ 结果后处理（setResultAugmenter）└─ 结果截断 + todo 快照
```

## 三、变更范围

### 3.1 ToolRegistry 改造

| 变更 | 说明 |
|------|------|
| 新增 `getToolsForLLM(isPlanMode)` | 将 QueryEngine 的 plan-mode 标注逻辑移入 |
| 修正 `dispatch()` 返回类型 | `Promise<string>` → `Promise<ToolResult>` |
| 修正 `dispatch()` ctx 传递 | 新增 `ctx?: ToolContext` 参数，透传给 `tool.execute()` |
| 修正 `ToolInterceptor` 类型 | 返回值从 `string` 改为 `ToolResult` |
| 修正 `ToolResultAugmenter` 类型 | 参数和返回值从 `string` 改为 `ToolResult` |

### 3.2 QueryEngine 改造

| 变更 | 说明 |
|------|------|
| `QueryEngineConfig.tools` | `ToolDef[]` → `registry: ToolRegistry` |
| 工具查找（line 436） | `Array.find()` → `registry.get(name)` |
| plan-mode 标注（line 342） | 自行 map → `registry.getToolsForLLM(isPlanMode)` |
| `partitionToolCalls`（line 615） | `this.config.tools` → `this.config.registry.getAll()` |
| `getTools()`（line 1176） | `this.config.tools` → `this.config.registry.getAll()` |

### 3.3 调用方改造

| 文件 | 变更 |
|------|------|
| `src/main.ts` | 创建 ToolRegistry，注册所有工具，传入 `registry` |
| `src/gateway/SessionManager.ts` | 同上，暴露 `session.registry` 用于 MCP 热插拔 |
| `src/tools/AgentTool.ts` | 子智能体创建独立 registry |
| `src/core/coordinator/AgentPool.ts` | 子智能体创建独立 registry |
| `tests/unit/QueryEngine.test.ts` | `makeConfig` 改为创建 registry |

### 3.4 不变的部分

| 接口/模块 | 原因 |
|-----------|------|
| `TeamManager(baseTools: ToolDef[])` | 内部存储，不涉及工具查找 |
| `coordinatorPrompt(tools: ToolDef[])` | 只遍历生成 prompt，不查找 |
| `ToolScheduler(tools: ToolDef[])` | 只检查 parallelSafe，不查找 |
| `ALL_TOOLS` 导出 | 保留为注册源，由调用方注册到 registry |

## 四、实施步骤

| 步骤 | 工作量 | 内容 | 验证方式 | 状态 |
|------|--------|------|----------|------|
| 1 | 30min | ToolRegistry: 新增 `getToolsForLLM()`，修正 `dispatch()` 返回类型和 ctx | tsc + 现有测试 | ✅ |
| 2 | 30min | QueryEngine: `config.tools` → `config.registry`，改造 5 处访问 | tsc + QueryEngine 测试 | ✅ |
| 3 | 30min | main.ts / SessionManager.ts 改为创建 registry | tsc + 手动测试 | ✅ |
| 4 | 15min | AgentTool.ts / AgentPool.ts 子智能体 registry | tsc | ✅ |
| 5 | 15min | 测试文件适配 | npm test | ✅ |
| 6 | 15min | 更新文档 | - | ✅ |

## 五、风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| `dispatch()` 返回类型改动 | 低 — 零生产调用者 | 类型系统保证 |
| `QueryEngineConfig` 接口变更 | 中 — 5 个生产文件 + 测试 | 逐步改造，每步 tsc 验证 |
| 子智能体工具过滤 | 低 — 创建独立 registry 即可 | filterToolsForAgent 逻辑不变 |
| MCP 热插拔时 registry 更新 | 低 — register/unregister 已实现 | 通过 session.registry 暴露 |
