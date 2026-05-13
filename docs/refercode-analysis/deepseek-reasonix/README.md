# DeepSeek-Reasonix 源码分析报告

> 分析目标：`D:\myproject\hrids-agent\refercode\DeepSeek-Reasonix-main`
> 分析日期：2026-05-13
> 项目版本：v0.39.1 (TypeScript, Node ≥22)

---

## 项目简介

DeepSeek-Reasonix 是一个 DeepSeek 原生的 AI 编码代理 CLI 工具，核心设计哲学是 **"Cache-First"（缓存优先）**。整个系统围绕 DeepSeek 的前缀缓存机制精心设计，通过三层内存分区、工具调用修复管道和成本控制策略，实现了高效的多轮工具调用循环。

**核心特点**：
- **Cache-First Loop** — 所有设计决策优先考虑前缀缓存命中率
- **Tool-Call Repair** — 四步管道修复 DeepSeek 模型的工具调用问题
- **Flash-First Cost Control** — 默认使用廉价模型，按需自动升级
- **99.82% 缓存命中率** — 实际案例：435M input tokens，成本从 $61 降至 $12

## 文档结构

| 文档 | 内容 |
|------|------|
| [architecture.md](architecture.md) | 核心架构（Cache-First Loop、三层内存分区、事件驱动） |
| [repair-system.md](repair-system.md) | Tool-Call Repair 四步管道（scavenge、flatten、truncation、storm） |
| [cost-control.md](cost-control.md) | 成本控制四大机制（flash-first、auto-escalation、/pro、auto-compaction） |
| [reference-value.md](reference-value.md) | 参考价值评估与借鉴建议 |

## 技术栈

| 维度 | 详情 |
|------|------|
| **语言** | TypeScript 5.6+, ES2022, ESM |
| **CLI 框架** | Commander.js + Ink 5 (React 18) |
| **测试** | Vitest 2.x |
| **Lint** | Biome 1.9 |
| **构建** | tsup (bundle), tsx (dev) |
| **MCP** | stdio + SSE 传输 |

## 核心发现

### 高参考价值设计

1. **三层内存分区** — ImmutablePrefix / AppendOnlyLog / VolatileScratch，保证前缀缓存稳定性
2. **Tool-Call Repair 管道** — scavenge（从推理内容回收）+ flatten（Schema 扁平化）+ truncation（截断修复）+ storm（风暴抑制）
3. **Flash-First + Auto-Escalation** — 默认廉价模型，失败时自动升级
4. **本地 Tokenizer Preflight** — 发送前估算 token 数，避免 API 400 错误
5. **预算控制** — `/budget` 命令设置软性 USD 上限

### 架构亮点

```
┌─────────────────────────────────────────────────┐
│ IMMUTABLE PREFIX (system + tools + few-shots)   │ ← 缓存 key
├─────────────────────────────────────────────────┤
│ APPEND-ONLY LOG (对话历史)                       │ ← 追加写入
├─────────────────────────────────────────────────┤
│ VOLATILE SCRATCH (临时工作区)                    │ ← 每轮重置
└─────────────────────────────────────────────────┘
```
