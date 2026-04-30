# Agent 提问对话框实现说明

## 概述

将 web 端 Agent 提问（`ask_user`）从输入栏提示条改为模态对话框（Modal）方式，提升用户体验和交互一致性。

## 改动文件

### 1. 新建文件

#### `web/src/components/modals/AskUserModal.tsx`
- 参考 `PermissionModal.tsx` 的设计风格
- 显示 Agent 的问题
- 提供快捷选项按钮（如果有）
- 提供自由输入框
- 自动聚焦输入框
- 支持 Enter 提交，Shift+Enter 换行
- 点击遮罩不关闭（必须回答）

**主要功能：**
- 问题展示区（带背景色和边框）
- 快捷选项按钮区（可选）
- 自定义回答输入框（textarea）
- 提交按钮（禁用状态：输入为空）

### 2. 修改文件

#### `web/src/store/messageStore.ts`
**新增方法：**
```typescript
clearAskUser: (sessionId: string) => void
```
- 清空指定会话的 `pendingAskUser` 状态
- 与 `clearPermission` 保持一致的命名和实现风格

#### `web/src/components/pages/ChatPage.tsx`
**新增导入：**
```typescript
import { AskUserModal } from '../modals/AskUserModal.js'
```

**新增状态读取：**
```typescript
const sendUserReply = useSessionStore((s) => s.sendUserReply)
const pendingAskUser = useMessageStore((s) => s.pendingAskUser)
const clearAskUser = useMessageStore((s) => s.clearAskUser)

const currentAskUser = activeSessionId
  ? pendingAskUser.get(activeSessionId) ?? null
  : null
```

**新增回复处理函数：**
```typescript
function handleAskUserReply(answer: string) {
  if (!activeSessionId || !currentAskUser) return
  appendUserMessage(activeSessionId, answer)  // 追加到消息列表
  sendUserReply(activeSessionId, answer)      // 发送到后端
  clearAskUser(activeSessionId)               // 清空状态
}
```

**新增 Modal 渲染：**
```tsx
{currentAskUser && activeSessionId && (
  <AskUserModal
    sessionId={activeSessionId}
    askUserState={currentAskUser}
    onReply={handleAskUserReply}
  />
)}
```

#### `web/src/components/chat/InputBar.tsx`
**移除内容：**
1. 移除 `ask_user` 提示条 UI（第 789-812 行）
2. 移除 `askUserState` 相关的 store 读取
3. 移除 `sendUserReply` 的 store 读取
4. 移除 `pendingAskUser` 的 store 读取
5. 移除 `handleReply` 函数定义
6. 简化 `handleKeyDown`：移除 `askUserState` 判断
7. 简化 `canSend`：移除 `|| !!askUserState` 逻辑
8. 简化 textarea 的 `disabled` 和 `placeholder`
9. 简化发送按钮的 `onClick`

**保留内容：**
- plan 模式提示条
- plan 模式警告提示条
- continuation 提示条

## 交互流程

### 旧流程（提示条方式）
```
ask_user 消息到达
  ↓
messageStore 设置 pendingAskUser
  ↓
InputBar 检测到 askUserState
  ↓
在输入栏上方显示提示条
  ├── 问题文字
  ├── 可选选项按钮
  └── 用户在 textarea 中输入或点击选项
  ↓
用户按 Enter 或点击发送
  ↓
handleReply() 发送回复
  ↓
清空 pendingAskUser（done 时自动清空）
```

### 新流程（Modal 方式）
```
ask_user 消息到达
  ↓
messageStore 设置 pendingAskUser
  ↓
ChatPage 检测到 currentAskUser
  ↓
渲染 AskUserModal（模态框）
  ├── 显示问题
  ├── 快捷选项按钮（可选）
  ├── 自由输入框（自动聚焦）
  └── 提交按钮
  ↓
用户点击选项或输入后提交
  ↓
handleAskUserReply() 处理回复
  ├── appendUserMessage() 追加到消息列表
  ├── sendUserReply() 发送到后端
  └── clearAskUser() 清空状态
```

## 设计特点

### 1. 与权限请求保持一致
- 都使用 Modal 方式
- 相似的视觉风格和布局
- 统一的交互模式

### 2. 更突出的提示
- 全屏遮罩，无法忽视
- 问题内容更清晰
- 选项和输入分离，交互更明确

### 3. 更好的用户体验
- 自动聚焦输入框
- 支持键盘快捷键（Enter 提交）
- 点击遮罩不关闭（防止误操作）
- 输入为空时禁用提交按钮

### 4. 代码简化
- InputBar 逻辑更清晰
- 职责分离：InputBar 负责消息输入，Modal 负责 Agent 提问
- 减少条件判断和状态耦合

## 测试要点

1. **基本功能**
   - Agent 提问时弹出 Modal
   - 问题内容正确显示
   - 快捷选项按钮正常工作
   - 自由输入框正常工作
   - 提交后 Modal 关闭

2. **交互细节**
   - 自动聚焦输入框
   - Enter 提交，Shift+Enter 换行
   - 输入为空时提交按钮禁用
   - 点击遮罩不关闭

3. **消息流**
   - 回答追加到消息列表
   - 回答发送到后端
   - Agent 收到回答后继续执行

4. **边界情况**
   - 无快捷选项时只显示输入框
   - 会话切换时 Modal 正确关闭
   - 重连后状态正确恢复

## 兼容性

- 后端无需修改（`ask_user` 消息格式不变）
- 与现有的 `user_reply` 消息类型兼容
- 不影响其他提示条（plan、continuation）

## 未来改进

1. 可选的超时倒计时（类似权限请求）
2. 支持 Markdown 格式的问题内容
3. 支持更复杂的选项类型（如单选、多选）
4. 历史回答记录和快速重用
