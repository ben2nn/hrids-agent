# DeepSeek-TUI 状态管理与配置系统分析

---

## 一、状态管理（SQLite）

### 1.1 存储引擎

- **数据库**：SQLite（通过 `rusqlite` crate）
- **默认路径**：`~/.deepseek/state.db`
- **辅助索引**：`session_index.jsonl`（追加写入的 JSONL 格式）

### 1.2 数据模型

#### threads 表（21 个字段）

```rust
enum ThreadStatus {
    Running, Idle, Completed, Failed, Paused, Archived
}

enum SessionSource {
    Interactive, Resume, Fork, Api, Unknown
}
```

记录了：
- 状态、来源、git 上下文（sha、branch、origin_url）
- 沙箱策略、审批模式、memory_mode

#### 其他表

| 表 | 用途 |
|---|---|
| `thread_dynamic_tools` | 线程级动态工具注册 |
| `messages` | 对话消息记录（role、content、item_json） |
| `checkpoints` | 线程检查点（JSON 快照） |
| `jobs` | 后台任务状态跟踪 |

### 1.3 持久化机制

- **UPSERT 语义**：`ON CONFLICT ... DO UPDATE`，实现幂等写入
- **级联删除**：thread 删除时自动清理关联数据
- **软删除**：`archived` 布尔标记 + `archived_at` 时间戳
- **事务写入**：`persist_dynamic_tools` 使用 SQLite 事务保证原子性

### 1.4 索引策略

```sql
idx_threads_updated_at       -- updated_at DESC
idx_threads_archived_at      -- archived_at DESC
idx_threads_archived_updated -- (archived, updated_at DESC) 复合索引
idx_messages_thread_created_at -- (thread_id, created_at ASC)
idx_checkpoints_thread_created_at -- (thread_id, created_at DESC)
idx_jobs_updated_at          -- updated_at DESC
```

---

## 二、配置系统

### 2.1 配置文件

- **格式**：TOML
- **默认路径**：`~/.deepseek/config.toml`
- **环境变量覆盖**：`DEEPSEEK_CONFIG_PATH`
- **项目级配置**：`$WORKSPACE/.deepseek/config.toml`

### 2.2 多 Provider 架构

| Provider | 默认模型 | 默认 Base URL |
|----------|---------|--------------|
| Deepseek | deepseek-v4-pro | https://api.deepseek.com/beta |
| NvidiaNim | deepseek-ai/deepseek-v4-pro | https://integrate.api.nvidia.com/v1 |
| Openai | gpt-4.1 | https://api.openai.com/v1 |
| Openrouter | deepseek/deepseek-v4-pro | https://openrouter.ai/api/v1 |
| Novita | deepseek/deepseek-v4-pro | https://api.novita.ai/v1 |
| Fireworks | accounts/fireworks/models/deepseek-v4-pro | https://api.fireworks.ai/inference/v1 |
| Sglang | deepseek-ai/DeepSeek-V4-Pro | http://localhost:30000/v1 |
| Vllm | deepseek-ai/DeepSeek-V4-Pro | http://localhost:8000/v1 |
| Ollama | deepseek-coder:1.3b | http://localhost:11434/v1 |

### 2.3 四级配置优先级

```
CLI 标志 > 配置文件 > 密钥存储 > 环境变量
```

具体流程：
1. `CliRuntimeOverrides` — 命令行参数（最高优先级）
2. `EnvRuntimeOverrides` — 环境变量（`DEEPSEEK_*`、`NVIDIA_*` 等）
3. 配置文件中 `providers.<name>.api_key`
4. `Secrets` 门面的 `resolve_with_source`

### 2.4 项目级配置合并

`merge_project_overrides` 实现**字段级合并**（非整体替换）：
- 标量字段：仅当项目配置有值时覆盖
- Provider 子表：逐字段合并
- `extras` BTreeMap：支持任意扩展键

### 2.5 模型别名规范化

`normalize_model_for_provider` 将用户友好的别名映射到规范模型 ID：
- `deepseek-chat` → `deepseek-v4-flash`
- `deepseek-reasoner` → `deepseek-v4-pro`
- Ollama 特殊处理：保留用户输入的原始标签

---

## 三、密钥管理

### 3.1 架构设计

采用 trait 抽象 + 多后端策略：

```
KeyringStore (trait)
  ├── FileKeyringStore     -- JSON 文件后端（默认）
  ├── DefaultKeyringStore  -- OS 原生密钥链（opt-in）
  └── InMemoryKeyringStore -- 测试用内存存储
```

### 3.2 后端选择

通过 `DEEPSEEK_SECRET_BACKEND` 环境变量控制：
- `file` / `local` / `json`（默认）— 文件后端
- `system` / `keyring` / `os` — OS 密钥链

`Secrets::auto_detect()` 自动探测：若 OS 密钥链不可用，静默回退到文件后端。

### 3.3 文件后端安全

- **存储路径**：`~/.deepseek/secrets/secrets.json`
- **权限检查**（Unix）：
  - 读取时检查 `mode & 0o077 != 0` 则拒绝
  - 写入后强制设置 `0o600`
  - 父目录设置 `0o700`
- **防数据丢失**：读取失败时直接返回错误，而非静默覆盖

### 3.4 密钥解析链

```
密钥存储后端（keyring） → 环境变量（多别名查找）
```

例如 `nvidia-nim` 会依次检查：
1. `NVIDIA_API_KEY`
2. `NVIDIA_NIM_API_KEY`
3. `DEEPSEEK_API_KEY`（兼容性回退）

---

## 四、LLM 客户端

### 4.1 连接健康管理

**三态模型**：
```
Healthy → Degraded → Recovering
```

- 连续 2 次失败后标记为 Degraded
- Degraded 状态下定期发送探测请求（冷却期 15 秒）
- 探测成功后回到 Healthy 状态

### 4.2 速率限制

Token Bucket 速率限制器：
- 默认 RPS：8.0
- 默认突发容量：16.0
- 环境变量配置：`DEEPSEEK_RATE_LIMIT_RPS`、`DEEPSEEK_RATE_LIMIT_BURST`

### 4.3 重试策略

指数退避重试：
- 可配置的最大重试次数、初始延迟、最大延迟
- `Retry-After` 头部解析
- 分类错误标签（rate_limited, server_error, network_error, timeout）

### 4.4 SSE 流式处理

- 增量文本/推理内容推送
- 工具调用流式解析
- 背压控制（8MB 高水位标记）
- 流超时保护（`STREAM_MAX_DURATION_SECS`）
- 缓冲区池化复用

### 4.5 推理模式支持

- `reasoning_effort` 参数传递（off/low/medium/high/max）
- `reasoning_content` 跨轮次重放（保持前缀缓存热度）
- 工具调用轮次的推理内容保留
- 非推理模型的推理内容自动剥离
