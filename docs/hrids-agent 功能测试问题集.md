# hrids-agent 功能测试问题集

> 覆盖所有功能模块，共 75 个测试问题
> 最后更新：2026-04-13

---

## 一、基础工具测试

### 文件操作

1. 在当前工作目录创建一个名为 `hello.txt` 的文件，内容为 "Hello, hrids-agent!"，然后读取它并显示内容。
2. 读取 `package.json` 文件，只显示第 1-10 行。
3. 将 `hello.txt` 中的 "Hello" 替换为 "Hi"，然后确认修改成功。
4. 搜索当前目录下所有 `.ts` 文件，列出文件路径。
5. 在 `src/` 目录下递归搜索包含 "QueryEngine" 关键词的文件，显示匹配行。

### Shell 执行

6. 执行 `echo "当前时间是 $(date)"` 并显示结果。
7. 用 bash 工具列出当前目录的文件，然后切换到 `src/` 目录，再列出该目录的文件（测试工作目录持久化）。
8. 尝试执行 `rm -rf /`，观察是否被危险命令黑名单拦截。

### 网络工具

9. 获取 `https://example.com` 的网页内容，提取正文摘要。
10. 搜索 "TypeScript 5.7 新特性" 并总结主要变化。

---

## 二、任务管理工具测试

11. 创建一个包含 3 个任务的 Todo 列表：调研需求、编写代码、编写测试。
12. 将第一个任务标记为 `in_progress`，然后读取任务列表确认状态。
13. 将所有任务标记为 `completed`，再次读取确认。

---

## 三、定时任务工具测试

14. 创建一个每天早上 9 点执行 `echo "早安"` 的定时任务，名称为 `morning-greeting`。
15. 列出所有定时任务，确认刚才创建的任务存在。
16. 禁用 `morning-greeting` 任务，然后重新启用它。
17. 删除 `morning-greeting` 任务，确认列表为空。

---

## 四、记忆系统测试

18. 向长期记忆中写入一条 `preference` 类型的记忆："我偏好使用 TypeScript 严格模式"。
19. 向长期记忆中写入一条 `decision` 类型的记忆："决定使用 sqlite-vec 作为向量存储后端"。
20. 搜索记忆中关于 "TypeScript" 的内容，确认能找到刚才写入的记忆。
21. 向知识图谱写入三元组：主语 "hrids-agent"，谓语 "使用"，宾语 "sqlite-vec"。
22. 查看记忆系统统计，显示总数、类型分布和知识图谱规模。

---


---

## 六、权限管理测试

29. 以 `--readonly` 模式启动，尝试创建文件，观察是否被拒绝。
30. 以 `--plan` 模式启动，执行一个写操作，观察是否弹出确认提示。
31. 在 `ask` 模式下，执行 `file_write` 操作，选择 "alwaysAllow" 后，再次执行同类操作，确认不再询问。

---

## 七、斜杠命令测试

32. 输入 `/help`，查看所有可用命令列表。
33. 输入 `/cost`，查看当前会话的 token 用量和费用。
34. 输入 `/model`，查看当前使用的模型。
35. 输入 `/model gpt-4o`，切换到 OpenAI 模型（需配置 `OPENAI_API_KEY`）。
36. 输入 `/compact`，压缩当前对话历史，观察上下文是否缩减。
37. 输入 `/clear`，清空对话历史，确认重置成功。
38. 输入 `/session`，显示当前会话 ID。
39. 输入 `/plan`，切换到计划模式，再次输入 `/plan` 退出计划模式。

---

## 八、内置 Skill 测试

40. 在有 git 变更的目录下输入 `/commit`，观察是否自动生成 Conventional Commits 格式的提交信息。
41. 对 `src/core/QueryEngine.ts` 执行 `/review`，查看代码审查报告。
42. 对 `src/tools/SkillTool.ts` 执行 `/explain`，查看代码解释。
43. 对某个已知 bug 执行 `/fix`，观察定位和修复流程。
44. 执行 `/scaffold` 生成一个简单的 Express 路由模块骨架。
45. 对 `src/core/QueryEngine.ts` 执行 `/refactor`，观察重构建议。
46. 对 `src/tools/SkillTool.ts` 执行 `/test`，生成单元测试。
47. 对 `src/gateway/server.ts` 执行 `/docs`，生成文档注释。

---

## 九、多提供商切换测试

48. 使用 `--model deepseek-chat` 启动，发送一条消息，确认使用 DeepSeek 提供商。
49. 使用 `--model qwen-max` 启动，确认自动识别为阿里云百炼提供商。
50. 使用 `--provider ollama --model qwen2.5-coder:7b` 启动（需本地 Ollama），发送消息确认正常响应。
51. 使用 `--provider custom --base-url http://localhost:8080/v1 --api-key test` 启动，测试自定义端点。

---

## 十、会话管理测试

52. 启动后执行几轮对话，然后用 `--list-sessions` 查看会话列表，记录会话 ID。
53. 使用 `--resume <sessionId>` 恢复上一个会话，确认历史消息仍然存在。
54. 在对话中触发自动压缩（发送大量消息超过 20000 tokens 阈值），观察压缩事件。

---

## 十一、Gateway 模式测试

55. 以 `--gateway --gateway-port 3282 --gateway-token secret123` 启动，访问 `GET /health` 确认服务正常。
56. 调用 `POST /sessions` 创建新会话，记录返回的 `sessionId`。
57. 调用 `GET /sessions` 列出所有会话。
58. 通过 WebSocket 连接 `ws://127.0.0.1:3282/sessions/:id/stream`，发送消息并接收流式响应。
59. 通过 WebSocket 发送 `{ "type": "abort" }` 中止正在执行的任务。
60. 调用 `DELETE /sessions/:id` 销毁会话，确认返回成功。
61. 不携带 Bearer Token 访问 API，确认返回 401 鉴权失败。

---

## 十二、Server 模式测试

62. 以 `--server` 模式启动，通过 stdin 发送 `{ "message": "列出当前目录文件" }`，观察 NDJSON 输出。
63. 发送 `{ "type": "set_cwd", "cwd": "/tmp" }` 切换工作目录，再发送消息确认目录已变更。
64. 触发 `ask_user` 工具后，发送 `{ "type": "user_reply", "answer": "是的" }` 回复。

---

## 十三、配置系统测试

65. 查看 `~/.hrids-agent/config.json` 的当前配置内容。
66. 修改配置将 `maxTurns` 设为 10，重启后确认生效。
67. 设置 `maxBudgetUsd` 为 0.01，触发超出预算的场景，观察是否中止。
68. 配置一个 MCP 服务器，重启后确认工具列表中出现新工具。

---

## 十四、上下文感知测试

69. 在一个 git 仓库目录下启动，询问 "当前 git 状态是什么"，确认自动注入了 git 上下文。
70. 在项目根目录创建 `AGENT.md` 文件，写入自定义指令，重启后确认指令被注入到系统提示中。

---

## 十五、边界与异常测试

71. 尝试读取一个超过 1MB 的文件，观察是否触发大小限制提示。
72. 发送一个极长的消息（超过上下文窗口），观察自动压缩是否触发。
73. 在任务执行中按 Ctrl+C，确认任务被中止而不是退出程序（空闲时 Ctrl+C 才退出）。
74. 使用无效的 API Key 启动，观察错误提示是否友好。
75. 在 `--readonly` 模式下尝试调用 `memory_add`，观察是否被拦截（写操作）。

---

## 功能覆盖矩阵

| 功能模块 | 测试题号 | 工具/命令 |
|---------|---------|---------|
| 文件读写 | 1-5 | `file_read` / `file_write` / `file_edit` / `glob` / `grep` |
| Shell 执行 | 6-8 | `bash` |
| 网络工具 | 9-10 | `web_fetch` / `web_search` |
| 任务管理 | 11-13 | `todo_write` / `todo_read` |
| 定时任务 | 14-17 | `schedule_cron` |
| 记忆系统 | 18-22 | `memory_add` / `memory_search` / `memory_recall` / `memory_fact` / `memory_status` |
| 子智能体 | 23 | `agent` |
| 团队协调 | 24-28 | `team_create` / `team_delete` / `agent_spawn` / `team_status` / `team_wait` |
| 权限管理 | 29-31 | `--readonly` / `--plan` / `ask` 模式 |
| 斜杠命令 | 32-39 | `/help` `/cost` `/model` `/compact` `/clear` `/session` `/plan` |
| 内置 Skill | 40-47 | `/commit` `/review` `/explain` `/fix` `/scaffold` `/refactor` `/test` `/docs` |
| 多提供商 | 48-51 | DeepSeek / 阿里云 / Ollama / 自定义端点 |
| 会话管理 | 52-54 | `--list-sessions` / `--resume` / 自动压缩 |
| Gateway API | 55-61 | REST + WebSocket + 鉴权 |
| Server 模式 | 62-64 | NDJSON stdin / `set_cwd` / `user_reply` |
| 配置系统 | 65-68 | `config.json` / `maxTurns` / `maxBudgetUsd` / MCP |
| 上下文感知 | 69-70 | git 上下文 / `AGENT.md` |
| 边界异常 | 71-75 | 大文件 / 超长消息 / Ctrl+C / 无效 Key / readonly 拦截 |
