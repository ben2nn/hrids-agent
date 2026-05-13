# Hermes Agent 提供商与网关系统分析

---

## 一、提供商系统（providers/）

### 1.1 ProviderProfile 声明式配置

```python
@dataclass
class ProviderProfile:
    """LLM 提供商配置档案"""

    # 基础信息
    name: str                          # 提供商名称
    base_url: str                      # API 基础 URL
    api_key_env: str                   # API Key 环境变量名

    # 模型配置
    models: list[str]                  # 支持的模型列表
    default_model: str                 # 默认模型

    # 能力标志
    supports_tools: bool               # 工具调用支持
    supports_streaming: bool           # 流式输出支持
    supports_vision: bool              # 视觉能力支持
    supports_json_mode: bool           # JSON 模式支持

    # 限制参数
    max_tokens: int                    # 最大输出 token
    max_context: int                   # 最大上下文窗口
    rate_limit: float                  # 每秒请求数限制

    # 自定义转换
    headers: dict[str, str]            # 自定义请求头
    transform_request: Callable        # 请求体转换
    transform_response: Callable       # 响应体转换
```

### 1.2 请求/响应转换

```python
# OpenAI 兼容提供商
openai_profile = ProviderProfile(
    name="openai",
    base_url="https://api.openai.com/v1",
    transform_request=identity,       # 直接透传
    transform_response=identity,
)

# Anthropic 提供商（需要格式转换）
anthropic_profile = ProviderProfile(
    name="anthropic",
    base_url="https://api.anthropic.com/v1",
    transform_request=convert_to_anthropic_format,
    transform_response=convert_from_anthropic_format,
)

# 国内提供商（通常兼容 OpenAI 格式）
deepseek_profile = ProviderProfile(
    name="deepseek",
    base_url="https://api.deepseek.com/v1",
    transform_request=identity,       # 兼容 OpenAI 格式
    transform_response=identity,
)
```

### 1.3 三层发现机制

```
Layer 1: 内置提供商（providers/builtin/）
    ├── openai.py
    ├── anthropic.py
    ├── google.py
    ├── mistral.py
    ├── deepseek.py
    ├── ollama.py
    └── ... (15+ 内置)

Layer 2: 插件提供商（Python entry_points）
    # setup.cfg 或 pyproject.toml
    [options.entry_points]
    hermes.providers =
        custom_llm = my_package.providers:CustomProvider

Layer 3: 用户自定义（~/.hermes/providers/）
    # JSON 配置文件
    {
        "name": "my_local_llm",
        "base_url": "http://localhost:8000/v1",
        "api_key_env": "LOCAL_LLM_KEY",
        "models": ["my-model-7b"],
        "default_model": "my-model-7b"
    }
```

### 1.4 提供商统一调用接口

```python
class ProviderManager:
    """提供商管理器"""

    def __init__(self):
        self.providers: dict[str, ProviderProfile] = {}
        self._discover_providers()

    async def call(
        self,
        provider_name: str,
        messages: list[dict],
        model: str = None,
        tools: list[dict] = None,
        stream: bool = False,
    ) -> ProviderResponse:
        # 1. 获取 Profile
        profile = self.providers[provider_name]

        # 2. 选择模型
        model = model or profile.default_model

        # 3. 转换请求
        request = profile.transform_request({
            "model": model,
            "messages": messages,
            "tools": tools,
            "stream": stream,
        })

        # 4. 发送请求
        response = await self._http_call(profile, request)

        # 5. 转换响应
        return profile.transform_response(response)
```

---

## 二、网关系统（gateway/）

### 2.1 Platform 动态枚举

```python
class Platform(str, Enum):
    """消息平台枚举，支持动态成员"""

    # 内置平台
    TELEGRAM = "telegram"
    DISCORD = "discord"
    SLACK = "slack"
    WHATSAPP = "whatsapp"
    FEISHU = "feishu"          # 飞书
    DINGTALK = "dingtalk"      # 钉钉
    WECHAT = "wechat"          # 微信
    MATRIX = "matrix"
    IRC = "irc"

    # 动态成员支持
    @classmethod
    def _missing_(cls, value: str):
        """允许动态注册新平台"""
        member = str.__new__(cls, value)
        member._name_ = value.upper()
        member._value_ = value
        cls._value2member_map_[value] = member
        return member
```

### 2.2 BasePlatformAdapter 抽象基类

```python
class BasePlatformAdapter(ABC):
    """平台适配器抽象基类"""

    @property
    @abstractmethod
    def platform(self) -> Platform:
        """平台标识"""
        ...

    @abstractmethod
    async def start(self) -> None:
        """启动平台监听"""
        ...

    @abstractmethod
    async def stop(self) -> None:
        """停止平台监听"""
        ...

    @abstractmethod
    async def send_message(
        self,
        chat_id: str,
        text: str,
        reply_to: str = None,
        media: list[MediaAttachment] = None,
    ) -> None:
        """发送消息"""
        ...

    @abstractmethod
    async def handle_update(self, update: dict) -> None:
        """处理平台更新"""
        ...

    # 通用方法（可选覆盖）
    async def format_message(self, text: str) -> str:
        """格式化消息（Markdown 转平台特定格式）"""
        return text

    async def parse_command(self, text: str) -> tuple[str, str]:
        """解析命令（如 /start -> ('start', '')）"""
        ...
```

### 2.3 平台适配器实现示例

```python
class TelegramAdapter(BasePlatformAdapter):
    """Telegram 平台适配器"""

    @property
    def platform(self) -> Platform:
        return Platform.TELEGRAM

    async def start(self):
        self.bot = Bot(token=self.config.telegram_token)
        self.updater = Updater(self.bot)
        self.updater.start_polling()

    async def send_message(self, chat_id, text, reply_to=None, media=None):
        if media:
            await self.bot.send_media_group(chat_id, media)
        else:
            await self.bot.send_message(
                chat_id,
                text,
                parse_mode='Markdown',
                reply_to_message_id=reply_to,
            )

    async def handle_update(self, update):
        message = update.message
        user_id = str(message.from_user.id)
        chat_id = str(message.chat.id)
        text = message.text

        # 转换为统一格式
        unified = UnifiedMessage(
            platform=self.platform,
            user_id=user_id,
            chat_id=chat_id,
            text=text,
            timestamp=message.date,
        )

        # 交给 AIAgent 处理
        await self.agent.handle_message(unified)
```

### 2.4 统一消息格式

```python
@dataclass
class UnifiedMessage:
    """跨平台统一消息格式"""

    platform: Platform           # 来源平台
    user_id: str                 # 用户 ID
    chat_id: str                 # 会话 ID
    text: str                    # 消息文本
    timestamp: datetime          # 时间戳

    # 可选字段
    reply_to: str = None         # 回复目标
    media: list[MediaAttachment] = None  # 媒体附件
    metadata: dict = None        # 平台特定元数据
```

---

## 三、ACP 适配器（acp_adapter/）

### 3.1 Agent Communication Protocol

ACP 是面向代码编辑器的通信协议，允许 IDE 直接调用 Hermes Agent。

```python
class HermesACPAgent:
    """ACP 协议适配器"""

    def __init__(self, agent: AIAgent):
        self.agent = agent
        self.server = ACPServer()

    async def handle_request(self, request: ACPRequest) -> ACPResponse:
        if request.method == "chat":
            response = await self.agent.run_conversation(request.params.message)
            return ACPResponse(result=response)

        elif request.method == "tools":
            tools = self.agent.registry.list_tools()
            return ACPResponse(result=tools)

        elif request.method == "execute":
            result = await self.agent.execute_tool(
                request.params.tool,
                request.params.args,
            )
            return ACPResponse(result=result)
```

### 3.2 工具类型映射

```python
TOOL_KIND_MAP = {
    'file': 'file',        # 文件操作 → 文件类工具
    'shell': 'terminal',   # Shell → 终端类工具
    'web': 'search',       # 网络 → 搜索类工具
    'code': 'analysis',    # 代码 → 分析类工具
}
```

---

## 四、MCP 服务器（mcp_serve.py）

### 4.1 暴露的 MCP 工具

| 工具 | 功能 | 参数 |
|------|------|------|
| `create_session` | 创建新会话 | title, metadata |
| `list_sessions` | 列出会话 | limit, offset |
| `get_session` | 获取会话详情 | session_id |
| `delete_session` | 删除会话 | session_id |
| `send_message` | 发送消息 | session_id, message |
| `get_messages` | 获取消息历史 | session_id, limit |
| `search_messages` | 全文搜索消息 | query, session_id |
| `export_session` | 导出会话 | session_id, format |
| `import_session` | 导入会话 | data, format |
| `get_agent_status` | 获取代理状态 | 无 |

### 4.2 跨平台会话管理

```python
# 通过 MCP 工具实现跨平台会话管理
# 例如：从 VS Code 中查看 Telegram 会话历史

search_messages(query="bug fix", session_id="telegram:12345")
# → 利用 FTS5 全文搜索，返回相关消息
```

---

## 五、架构总结

### 数据流

```
消息平台（Telegram/Discord/Slack/...）
    ↓
BasePlatformAdapter.handle_update()
    ↓
UnifiedMessage（统一格式）
    ↓
AIAgent.handle_message()
    ├── 构建系统提示词
    ├── ProviderManager.call() → LLM
    ├── ToolRegistry.execute() → 工具
    └── 状态持久化
    ↓
BasePlatformAdapter.send_message()
    ↓
消息平台
```

### 关键设计特点

1. **声明式 Provider** — Profile 数据类，而非继承链
2. **动态 Platform** — 枚举支持运行时注册新平台
3. **统一消息格式** — 跨平台消息抽象
4. **ACP 集成** — 代码编辑器直接调用
5. **MCP 暴露** — 10 个工具支持跨平台会话管理
