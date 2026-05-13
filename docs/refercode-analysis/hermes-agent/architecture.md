# Hermes Agent 架构设计分析

---

## 一、整体架构

### 1.1 核心类：AIAgent

`run_agent.py` 中的 `AIAgent` 类是整个系统的核心，约 15000 行代码，承担了：
- 对话循环管理
- 工具调用编排
- 状态持久化
- 系统提示词构建
- 轨迹压缩

### 1.2 对话循环（run_conversation）

```python
async def run_conversation(self, user_message: str) -> str:
    # 1. 构建系统提示词（3 层缓存）
    system_prompt = self._build_system_prompt()

    # 2. 加载历史消息
    messages = self.state.get_messages(session_id)

    # 3. 主循环
    while True:
        # 3a. 调用 LLM
        response = await self.call_provider(messages, system_prompt)

        # 3b. 处理工具调用
        if response.tool_calls:
            tool_results = await self._execute_tools(response.tool_calls)
            messages.append(tool_results)
            continue  # 带结果继续循环

        # 3c. 无工具调用，返回最终回复
        return response.content
```

**关键设计**：
- 工具调用结果反馈回循环继续生成
- 支持多轮工具调用（tool chaining）
- 每轮都可能触发轨迹压缩

---

## 二、状态管理（hermes_state.py）

### 2.1 SQLite + FTS5

```python
class HermesState:
    """全局状态管理，基于 SQLite"""

    def __init__(self, db_path: str):
        self.db = sqlite3.connect(db_path)
        self._init_tables()
        self._init_fts5()
```

**核心表结构**：

| 表 | 用途 |
|------|------|
| `sessions` | 会话元数据 |
| `messages` | 消息历史 |
| `tools` | 工具注册表 |
| `skills` | 技能元数据 |
| `messages_fts` | FTS5 全文搜索索引 |

**FTS5 特性**：
- 支持 `trigram` tokenizer，用于 CJK 语言模糊搜索
- 消息自动索引，支持语义搜索历史对话

### 2.2 系统提示词 3 层缓存

```
Layer 1: 静态部分（角色定义、行为规范）
    ↓ 缓存键：角色 + 版本
Layer 2: 动态部分（可用工具列表、当前时间）
    ↓ 缓存键：工具哈希
Layer 3: 上下文部分（会话摘要、用户偏好）
    ↓ 每次重新生成
```

**优化效果**：Layer 1 和 Layer 2 通常占据系统提示词 80%+ 的内容，缓存后大幅减少重复构建开销。

---

## 三、提供商系统（providers/）

### 3.1 ProviderProfile 声明式配置

```python
@dataclass
class ProviderProfile:
    name: str                          # 提供商名称
    base_url: str                      # API 基础 URL
    api_key_env: str                   # 环境变量名
    models: list[str]                  # 支持的模型列表
    default_model: str                 # 默认模型
    supports_tools: bool               # 是否支持工具调用
    supports_streaming: bool           # 是否支持流式
    supports_vision: bool              # 是否支持视觉
    max_tokens: int                    # 最大 token 数
    headers: dict[str, str]            # 自定义请求头
    transform_request: Callable        # 请求转换函数
    transform_response: Callable       # 响应转换函数
```

**设计哲学**：通过声明式配置而非继承来定义提供商差异，新提供商只需创建一个 Profile 实例。

### 3.2 三层发现机制

```
Layer 1: 内置提供商（hardcoded）
    ↓ OpenAI、Anthropic、Google 等主流提供商
Layer 2: 插件提供商（entry_points）
    ↓ 通过 Python entry_points 机制发现
Layer 3: 用户自定义（~/.hermes/providers/）
    ↓ 用户放置 JSON/YAML 配置文件
```

### 3.3 支持的提供商（28+）

| 类别 | 提供商 |
|------|--------|
| 一线 | OpenAI、Anthropic、Google、Mistral |
| 国内 | 通义千问、文心一言、智谱、Moonshot、DeepSeek |
| 开源 | Ollama、vLLM、Together、Groq、Fireworks |
| 代理 | OpenRouter、LiteLLM |
| 其他 | Cohere、AI21、Perplexity、xAI |

---

## 四、轨迹压缩

### 4.1 触发条件

```python
def _should_compress(self, messages: list) -> bool:
    token_count = self._count_tokens(messages)
    return token_count > self.compression_threshold  # 默认 80% of max_tokens
```

### 4.2 压缩策略

```
原始消息 → 保留最近 N 轮 → 旧消息摘要化 → 合并系统消息
```

- **保留窗口**：最近 5-10 轮对话保持完整
- **摘要化**：旧消息通过 LLM 生成摘要
- **工具结果裁剪**：过长的工具结果被截断并标记 `[truncated]`

---

## 五、架构总结

```
用户输入
    ↓
CLI (cli.py)
    ↓
AIAgent (run_agent.py)
    ├── 构建系统提示词（3 层缓存）
    ├── 加载历史消息（SQLite）
    ├── 调用 Provider（28+ 适配器）
    ├── 执行工具（Registry + Toolset）
    ├── 轨迹压缩（token 阈值触发）
    └── 持久化状态（SQLite + FTS5）
    ↓
响应输出
```

### 关键设计特点

1. **插件驱动** — Provider、Gateway、Tool 三套独立插件系统
2. **声明式配置** — ProviderProfile 数据类而非继承
3. **缓存优先** — 系统提示词 3 层缓存，减少重复构建
4. **全文搜索** — SQLite FTS5 + trigram，支持 CJK 语义搜索
5. **轨迹压缩** — token 阈值触发，保留最近窗口 + 旧消息摘要化
