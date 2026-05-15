# CLI 虚拟滚动改进计划

## Context

当前项目的 CLI 消息列表使用简单的 `slice(-50)` 截断渲染，所有消息仍在 React 树中，不是真正的虚拟滚动。参照 DeepSeek-Reasonix 的实现，改为**行精度虚拟滚动**：不可见卡片用 spacer 占位、负 marginTop 滚动、卡片高度实时测量缓存。

已确认 Ink 5 兼容性：
- `measureElement(node: DOMElement) => { width, height }` ✅ 可用
- `overflow: hidden` 裁剪 ✅ 可用
- 负 `marginTop` ✅ Yoga 支持
- `Box` 支持 `ref` 获取 `DOMElement` ✅ (`RefAttributes<DOMElement>`)

---

## 新建文件（4个）

### 1. `src/cli/ui/scroll-store.ts`
外部 pub-sub 滚动状态存储，无 React 依赖。

**状态**: `scrollOffset`, `pinned`, `cardHeights: Map<string, number>`, `maxScroll`

**核心算法** `getViewportState(msgs, viewportHeight)`:
1. 遍历消息，用缓存高度或估算高度累加 → `totalHeight`
2. clamp `scrollOffset` 到 `[0, max(0, totalHeight - viewportHeight)]`
3. 从头累加高度找到第一个超过 scrollOffset 的卡片 → `startIndex`
4. `topSpacer` = 前面卡片高度之和
5. `marginTop` = `-(scrollOffset - topSpacer)` 处理首张卡片部分可见
6. 继续累加直到超过 viewportHeight → `endIndex`（+2行缓冲）
7. `bottomSpacer` = 剩余高度

**方法**: `scroll(delta)` / `scrollToBottom()` / `registerHeight(id, h)` / `setPinned(bool)` / `subscribe(cb)` / `getSnapshot()`

**16ms 合并**: 快速滚动事件通过 `setTimeout` 合并，避免频繁通知。

**高度估算** `estimateCardHeight(text, cols)`: 1行 header + 每行按终端宽度换行（CJK 宽字符算2列）+ 1行间距。

### 2. `src/cli/ui/useTerminalSize.ts`
Hook 返回 `{ cols, rows }`，监听 `process.stdout.on('resize')` 更新。

### 3. `src/cli/ui/ScrollProvider.tsx`
React Context 桥接层：
- `ScrollProvider` 组件：用 `useMemo` 创建 store 实例，放入 Context
- `useScrollStore()` hook：返回 store 引用（稳定，不触发重渲染）
- `useScrollSnapshot()` hook：`useSyncExternalStore` 订阅，只有选中切片变化时重渲染

### 4. `src/cli/ui/CardStream.tsx`
虚拟滚动渲染组件。

**Props**: `{ msgs: DisplayMsg[], viewportHeight: number }`

**渲染结构**:
```tsx
<Box height={viewportHeight} overflow="hidden" flexDirection="column">
  <Box flexDirection="column" marginTop={marginTop}>
    <Box height={topSpacer} flexShrink={0} />
    {visibleMsgs.map(msg => <MeasuredCard key={msg.id} msg={msg} />)}
    <Box height={bottomSpacer} flexShrink={0} />
  </Box>
</Box>
```

**MeasuredCard** 子组件：
- `<Box ref={ref}><MessageCard {...msg} /></Box>`
- `useEffect` 中调用 `measureElement(ref.current)` 获取实际高度
- 高度变化时调用 `store.registerHeight(msg.id, height)`

---

## 修改文件（1个）

### `src/cli/ui/App.tsx`

**改动点**:

1. **消息 ID 生成**: `push()` 始终分配唯一 ID（`msg-${++counter}`），初始消息也加 ID

2. **替换消息渲染块**（原 L443-451）:
   - 删除: `msgs.slice(...).slice(-50).map(MessageCard)`
   - 替换为: `<CardStream msgs={msgs} viewportHeight={viewportHeight} />`
   - `viewportHeight` = `termRows - FIXED_OVERHEAD`（splash ~14 + input ~2 + separator ~1 + status ~1 + margins ~5 ≈ 23，工具/流式进度区动态出现时会压缩 viewport，由 overflow:hidden 兜底）

3. **滚动控制迁移**:
   - 删除: `scrollRows` state, `pinned` state, `pinnedRef`, `MAX_VISIBLE_LINES`, `SCROLL_PAGE`, `jumpToBottom()`
   - `useInput` 中的滚动处理改为调用 `store.scroll(delta)` / `store.scrollToBottom()` / `store.setPinned(false)`

4. **pinned 指示器**: 通过 `useScrollSnapshot()` 读取 `pinned` 状态

5. **状态栏位置指示**: 删除原有的 `scrollRows` 相关显示（或改为从 store 读取）

---

## 数据流

```
App.tsx (msgs state)
  │ push(msg) → setMsgs + store.scrollToBottom() if pinned
  │
  └─ <CardStream msgs={msgs} viewportHeight={N}>
       │ useSyncExternalStore → { startIndex, endIndex, topSpacer, bottomSpacer, marginTop }
       │
       └─ Box(overflow=hidden, height=N)
            └─ Box(marginTop=-N)
                 ├─ Box(height=topSpacer)     ← 不可见上方卡片占位
                 ├─ MeasuredCard × K          ← 仅渲染可视区卡片
                 └─ Box(height=bottomSpacer)  ← 不可见下方卡片占位
```

## 实现顺序

1. `scroll-store.ts`（纯逻辑，可独立测试）
2. `useTerminalSize.ts`（简单 hook）
3. `ScrollProvider.tsx`（Context 桥接）
4. `CardStream.tsx`（虚拟滚动渲染）
5. 修改 `App.tsx`（集成）

## 验证

- `npm run build` 编译通过
- 启动 CLI（`npm run dev` 或等效命令），发送多条消息测试：
  - 少量消息（<10条）：应全部可见，无多余空白
  - 大量消息（50+条）：向上翻页流畅，自动跟随新消息
  - 长消息（多行换行）：高度测量准确
  - PageUp/PageDown/↑/↓/End 键行为正确
  - 新消息到达时自动滚到底部（pinned 模式）
  - 终端 resize 后布局自适应
