# hrids-agent

一个原创 AI 智能体 CLI，支持多种 LLM 提供商，具备工具调用、记忆系统、多智能体协作和 IM 平台接入能力。

---

## 目录

- [快速开始](#快速开始)
- [安装](#安装)
- [配置](#配置)
- [使用方式](#使用方式)
- [运行模式](#运行模式)
- [权限模式](#权限模式)

---

## 快速开始

```bash
# 安装依赖
npm install

# 初始化配置
npx tsx src/main.ts init

# 启动交互模式
npm run dev

# 启动 Gateway（Web UI + API）
npm run gateway
```

---

## 安装

**环境要求**：Node.js ≥ 18.0.0

```bash
# 从源码运行（开发模式）
npm install
npm run dev

# 构建后运行
npm run build
node dist/main.js

# 全局安装（构建后）
npm install -g .
hrids-agent
```

---

## 配置

首次运行会自动生成配置文件 `~/.hrids-agent/config.json`，也可手动初始化：

```bash
hrids-agent init
```

最简配置示例（使用阿里云 Qwen）：

```json
{
  "llm": {
    "fallbacks": [
      {
        "provider": "aliyun",
        "models": ["qwen-plus-2025-07-28"],
        "apiKey": "sk-xxxxxxxx"
      }
    ]
  }
}
```

详细配置说明见 [配置参考文档](./config-reference.md)。

---

## 使用方式

```bash
# 交互模式（默认）
hrids-agent

# 非交互模式（执行单条消息后退出）
hrids-agent -p "帮我写一个 hello world"

# 指定模型
hrids-agent -m deepseek-chat
hrids-agent -m qwen-max --provider aliyun

# Ollama 本地模型
hrids-agent -m qwen2.5-coder:7b --provider ollama

# 恢复上次会话
hrids-agent --resume <sessionId>

# 列出历史会话
hrids-agent --list-sessions

# 启动 Gateway 服务
hrids-agent --gateway
hrids-agent --gateway --gateway-port 8080
```

---

## 运行模式

| 模式 | 命令 | 说明 |
|------|------|------|
| 交互模式 | `hrids-agent` | Ink TUI 界面，支持斜杠命令 |
| 非交互模式 | `hrids-agent -p "消息"` | 执行单条消息后退出 |
| Server 模式 | `hrids-agent --server` | 从 stdin 读取 NDJSON 消息，保持会话历史 |
| Gateway 模式 | `hrids-agent --gateway` | HTTP + WebSocket 服务，供前端或远程客户端连接 |

---

## 权限模式

| 模式 | 说明 |
|------|------|
| `ask`（默认） | 每次写操作都询问用户确认 |
| `craft` | 自主执行模式，agent 独立完成任务，无需确认 |
| `plan` | 只读规划模式，所有写操作被禁止 |

```bash
# 启动时指定权限模式
hrids-agent --craft
hrids-agent --plan
```

---

## 支持的 LLM 提供商

| 提供商 | provider 值 | 说明 |
|--------|-------------|------|
| Anthropic | `anthropic` | Claude 系列 |
| OpenAI | `openai` | GPT 系列 |
| DeepSeek | `deepseek` | DeepSeek 系列 |
| 阿里云 | `aliyun` | Qwen 系列 |
| 智谱 | `zhipu` | GLM 系列 |
| Kimi | `kimi` | Moonshot 系列 |
| MiniMax | `minimax` | |
| Google | `google` | Gemini 系列 |
| OpenRouter | `openrouter` | 多模型聚合 |
| Ollama | `ollama` | 本地模型，无需 API Key |
| 自定义 | `custom` | 自定义 OpenAI 兼容端点 |
