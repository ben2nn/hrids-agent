# 实现计划：cli-display-format

## 概述

对 `src/ui/App.tsx` 进行显示层重构，建立统一的 CLI 对话显示格式规范。核心变更包括：ToolBlock 合并（tool_start/log/end 三事件合并为单条消息）、cost 移出对话流（写入独立 costInfo state）、assistant 前缀统一为 `✦ `、黄色语义化（permission_denied 和 cron 触发）、StatusBar 完整化。

## 任务

- [x] 1. 安装 fast-check 并扩展 DisplayMsg 接口
  - 运行 `npm install --save-dev fast-check` 安装属性测试库
  - 在 `src/ui/App.tsx` 中将 `MsgRole` 类型移除 `'cost'`，保留 `'user' | 'assistant' | 'tool' | 'system' | 'error'`
  - 在 `DisplayMsg` 接口中新增可选字段 `id?: string` 和 `color?: string`
  - 更新 `ROLE_COLOR` 映射，移除 `cost` 键
  - 更新 `ROLE_PREFIX` 映射，将 `assistant` 改为 `'✦ '`，移除 `cost` 键
  - _需求：4.1、4.4、6.1–6.4_

- [x] 2. 新增 updateMsg 函数与 costInfo state
  - 在 `App` 组件中新增 `costInfo` state，类型为 `CostInfo | null`（接口含 `inputTokens`、`outputTokens`、`costUsd`）
  - 新增 `updateMsg(id: string, updater: (prev: DisplayMsg) => DisplayMsg)` 函数，通过 id 定位并原地更新 msgs 数组中的消息
  - 修改 `push` 函数签名，接受 `DisplayMsg` 对象（而非 role + text 两个参数），以支持传入 `id` 和 `color` 字段
  - _需求：1.3、5.1_

- [x] 3. 重构 tool_start / tool_end 事件处理（ToolBlock 合并）
  - 修改 `tool_start` 处理：调用 `push({ id: ev.id, role: 'tool', text: '⚙ ${ev.name}  ${ev.description}' })`，同时重置 `currentToolLogsRef.current = []`
  - 修改 `tool_end` 成功处理：调用 `updateMsg(ev.id, prev => ...)` 将日志（最多 30 行）和 `✓ {name}` 结果行合并追加到同一 ToolBlock；output 超过 500 字符时截断并追加 `\n…（共 N 字符）` 提示
  - 修改 `tool_end` 失败处理：调用 `updateMsg(ev.id, prev => ...)` 追加 `✗ {name}: {message}`，并设置 `color: 'red'`
  - 降级处理：若 `updateMsg` 找不到对应 id，降级为 `push` 追加新消息
  - _需求：1.1、1.3、1.4、1.5、1.6、2.2、2.3、3.1–3.5_

- [x] 4. 重构 usage 事件处理，迁移至 costInfo state
  - 将 `usage` 事件处理从 `push('cost', ...)` 改为 `setCostInfo({ inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsd: ev.costUsd })`
  - 确保 `msgs` 数组不因 `usage` 事件而增加任何条目
  - _需求：5.1、5.2_

- [x] 5. 重构 permission_denied 和 cron 触发消息（黄色语义化）
  - 将 `permission_denied` 处理改为：`push({ role: 'system', text: '⚠ 已拒绝: ${ev.description}', color: 'yellow' })`
  - 将 `runEngine` 中 cron 触发的 `displayAs` 消息改为：`push({ role: 'system', text: displayAs, color: 'yellow' })`（仅当 displayAs 以 `⏰` 开头时）
  - _需求：7.1、7.2、7.3、9.1、9.2_

- [x] 6. 更新渲染逻辑：颜色覆盖、streamBuf 前缀、StatusBar
  - 消息列表渲染：将 `color={ROLE_COLOR[m.role]}` 改为 `color={m.color ?? ROLE_COLOR[m.role]}`，支持 `DisplayMsg.color` 覆盖默认颜色
  - streamBuf 渲染：将 `<Text color="white">{streamBuf}</Text>` 改为 `<Text color="white">✦ {streamBuf}</Text>`
  - StatusBar 渲染：在 provider 和 model 信息后追加 `{costInfo && ' 输入 ${costInfo.inputTokens} / 输出 ${costInfo.outputTokens} tokens  累计 ${costInfo.costUsd.toFixed(4)}'}`
  - _需求：4.2、4.3、5.2、5.3、10.1–10.5_

- [x] 7. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户提问。

- [ ] 8. 编写属性测试（fast-check）
  - [x] 8.1 搭建测试文件骨架
    - 创建 `src/ui/__tests__/App.display.test.ts`
    - 提取 App.tsx 中的纯函数逻辑（updateMsg、ToolBlock 合并、日志截断、output 截断）到可测试的辅助函数，或直接在测试中模拟状态变更
    - 引入 `fast-check` 和 `vitest`

  - [ ]* 8.2 属性 1：ToolBlock 合并唯一性
    - 生成随机工具名称、日志行序列（0–50 行）、结果类型（success/error）
    - 模拟 `tool_start → tool_log × N → tool_end` 事件序列处理
    - 断言：msgs 中与该 tool id 对应的条目有且仅有一条，且文本包含工具名称和结果状态行
    - **属性 1：ToolBlock 合并唯一性**
    - **验证：需求 1.1、1.3、1.4、1.5、1.6、2.3**

  - [ ]* 8.3 属性 2：tool_log 不重复渲染
    - 生成随机 tool_log 行序列
    - 断言：tool_end 后 toolProgress 为空，日志内容已迁移到 ToolBlock，不同时存在于两处
    - **属性 2：tool_log 不重复渲染**
    - **验证：需求 2.1、2.2、2.3**

  - [ ]* 8.4 属性 3：stderr 行被过滤
    - 生成随机 `[stderr]` 前缀行（任意后缀内容）
    - 断言：该行内容既不出现在 toolProgress 中，也不出现在 msgs 的任何 ToolBlock 中
    - **属性 3：stderr 行被过滤**
    - **验证：需求 2.4**

  - [ ]* 8.5 属性 4：tool_log 截断保留最后 N 行
    - 生成超过 30 行的随机日志序列（31–100 行）
    - 断言：ToolBlock 中保留的日志行数 ≤ 30，且文本包含 `…（省略前 K 行）` 提示，K 为被省略行数
    - **属性 4：tool_log 截断保留最后 N 行**
    - **验证：需求 3.1、3.2**

  - [ ]* 8.6 属性 5：tool_end output 截断
    - 生成长度超过 500 字符的随机 output 字符串
    - 断言：ToolBlock 中显示的 output 不超过 500 字符，且追加了 `…（共 N 字符）` 提示，N 为原始总字符数
    - **属性 5：tool_end output 截断**
    - **验证：需求 3.3、3.4**

  - [ ]* 8.7 属性 6：assistant 消息前缀一致性
    - 生成随机 assistant 文本（任意 Unicode 字符串）
    - 断言：持久化消息的 ROLE_PREFIX['assistant'] 为 `✦ `，且与 user/system/error 前缀互不相同
    - **属性 6：assistant 消息前缀一致性**
    - **验证：需求 4.1、4.3、4.4**

  - [ ]* 8.8 属性 7：usage 事件不写入 msgs，costInfo 反映最新值
    - 生成随机 usage 事件序列（1–20 个事件，costUsd 单调递增）
    - 断言：处理完毕后 msgs 长度不变，costInfo 反映最后一次事件的值，costUsd 单调不减
    - **属性 7：usage 事件不写入 msgs，costInfo 反映最新值**
    - **验证：需求 5.1、5.2**

  - [ ]* 8.9 属性 8：黄色 system 消息颜色一致性
    - 生成随机 permission_denied description 和 cron description
    - 断言：对应 msgs 条目的 color 字段为 `'yellow'`
    - 生成 compact_start / compact_done 事件，断言对应 msgs 条目的 color 字段为 `undefined` 或 `'gray'`
    - **属性 8：黄色 system 消息颜色一致性**
    - **验证：需求 7.2、9.2**

  - [ ]* 8.10 属性 9：permission_denied 和 cron 消息文本完整性
    - 生成任意长度的随机 description 字符串（包含特殊字符、中文、空格）
    - 断言：permission_denied 消息文本完整包含该 description，不截断
    - 断言：cron 触发消息文本完整包含该 description，不截断
    - **属性 9：permission_denied 和 cron 消息文本完整性**
    - **验证：需求 7.1、7.3、9.1**

- [x] 9. 最终检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户提问。

## 备注

- 标有 `*` 的子任务为可选项，可跳过以加快 MVP 进度
- 每个任务均引用具体需求条款，保证可追溯性
- 属性测试使用 `fast-check`，每个属性最少运行 100 次迭代
- 单元测试和属性测试互补：属性测试验证普遍性，单元测试验证具体边界
- 所有修改仅限 `src/ui/App.tsx` 和新增测试文件，不涉及 QueryEngine 或工具层
