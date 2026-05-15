/**
 * 外部 pub-sub 滚动状态存储（无 React 依赖）
 * 参照 DeepSeek-Reasonix 的 chat-scroll-store 设计
 */

// ─── 类型定义 ──────────────────────────────────────────────────────────────

export interface ScrollSnapshot {
  scrollOffset: number       // 从内容顶部向下的行偏移（0=看顶部，maxScroll=看底部）
  pinned: boolean            // 是否锁定到底部
  maxScroll: number          // 最大可滚动行数
  scrollVersion: number      // 每次滚动递增，供消费者触发视觉反馈
}

export interface ViewportState {
  startIndex: number         // 第一个可见卡片索引
  endIndex: number           // 最后一个可见卡片索引（不含）
  topSpacer: number          // 上方不可见区域行高
  bottomSpacer: number       // 下方不可见区域行高
  marginTop: number          // 首张卡片部分可见时的负偏移
  pinned: boolean
  totalHeight: number
  maxScroll: number
}

export interface ScrollStore {
  getState(): ScrollSnapshot
  subscribe(cb: () => void): () => void
  getSnapshot(): ScrollSnapshot
  scroll(delta: number): void
  scrollToBottom(): void
  setPinned(pinned: boolean): void
  setMaxScroll(rows: number): void
  registerHeight(id: string, height: number): void
  pruneHeights(liveIds: ReadonlySet<string>): void
  getViewportState(msgs: { id?: string; text: string }[], viewportHeight: number, cols: number): ViewportState
}

// ─── 常量 ──────────────────────────────────────────────────────────────────

const SCROLL_ARROW_ROWS = 3
const SCROLL_PAGE_ROWS = 10
const COALESCE_MS = 16
const OVERSCAN_CARDS = 2  // 视口上下各多渲染几张卡片

// ─── CJK 宽字符宽度计算 ────────────────────────────────────────────────────

function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!
  // CJK 统一表意文字 + 扩展 + 兼容 + 符号
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  ) {
    return 2
  }
  return 1
}

function strDisplayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    w += charWidth(ch)
  }
  return w
}

// ─── 高度估算 ──────────────────────────────────────────────────────────────

/**
 * 估算一条消息卡片占用的终端行数
 * header 1行（glyph + role label）+ body 按宽度换行 + 1行间距
 */
export function estimateCardHeight(text: string, cols: number): number {
  const contentWidth = Math.max(1, cols - 4)  // paddingLeft=2 + 留白
  const lines = text.split('\n')
  let bodyRows = 0
  for (const line of lines) {
    const w = strDisplayWidth(line)
    bodyRows += Math.max(1, Math.ceil(w / contentWidth))
  }
  // header(1) + body + marginBottom(1)
  return 1 + bodyRows + 1
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────

export function createScrollStore(): ScrollStore {
  let state: ScrollSnapshot = {
    scrollOffset: 0,
    pinned: true,
    maxScroll: 0,
    scrollVersion: 0,
  }

  const listeners = new Set<() => void>()
  const cardHeights = new Map<string, number>()
  let pendingDelta = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function notify() {
    for (const cb of listeners) cb()
  }

  function set(partial: Partial<ScrollSnapshot>) {
    const prev = state
    state = { ...state, ...partial }
    // 浅比较所有字段，全部相等则跳过通知
    if (
      prev.scrollOffset === state.scrollOffset &&
      prev.pinned === state.pinned &&
      prev.maxScroll === state.maxScroll &&
      prev.scrollVersion === state.scrollVersion
    ) {
      return
    }
    notify()
  }

  function applyDelta() {
    const d = pendingDelta
    pendingDelta = 0
    if (d === 0) return

    // delta 语义：正数=向底部滚动（增大 offset），负数=向顶部滚动（减小 offset）
    // App.tsx 调用：PageUp=scroll(10), PageDown=scroll(-10)
    // 所以 d>0 表示"向上翻"→ 减小 offset，d<0 表示"向下翻"→ 增大 offset
    const next = Math.max(0, Math.min(state.scrollOffset - d, state.maxScroll))
    // d > 0 = 向顶部滚动（远离底部）→ 取消 pinned
    // d < 0 = 向底部滚动（靠近底部）→ 到底时恢复 pinned
    const newPinned = d > 0 ? false : next >= state.maxScroll ? true : state.pinned
    set({
      scrollOffset: next,
      pinned: newPinned,
      scrollVersion: state.scrollVersion + 1,
    })
  }

  function schedule(delta: number) {
    pendingDelta += delta
    if (flushTimer) return  // 已有定时器，等待 flush
    // leading edge: 立即执行
    applyDelta()
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (pendingDelta !== 0) applyDelta()
    }, COALESCE_MS)
  }

  return {
    getState() {
      return state
    },

    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },

    getSnapshot() {
      return state
    },

    scroll(delta) {
      schedule(delta)
    },

    scrollToBottom() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      pendingDelta = 0
      // 强制更新：即使 pinned 已经是 true，也要 bump scrollVersion 触发重渲染
      state = {
        ...state,
        pinned: true,
        scrollVersion: state.scrollVersion + 1,
      }
      notify()
    },

    setPinned(pinned) {
      set({ pinned })
    },

    setMaxScroll(rows) {
      const ms = Math.max(0, rows)
      // pinned 时 scrollOffset 由 getViewportState 实时计算，不需要在此设置
      // 非 pinned 时 clamp scrollOffset 防止超出范围
      set({
        maxScroll: ms,
        ...(state.pinned ? {} : { scrollOffset: Math.min(state.scrollOffset, ms) }),
      })
    },

    registerHeight(id, height) {
      const prev = cardHeights.get(id)
      if (prev === height) return
      cardHeights.set(id, height)
      // 高度变化影响 maxScroll，通知订阅者重新计算
      notify()
    },

    pruneHeights(liveIds) {
      let pruned = false
      for (const key of cardHeights.keys()) {
        if (!liveIds.has(key)) {
          cardHeights.delete(key)
          pruned = true
        }
      }
      if (pruned) notify()
    },

    getViewportState(msgs, viewportHeight, cols) {
      // 1. 计算每张卡片高度和总高度
      const heights: number[] = []
      let totalHeight = 0
      for (const msg of msgs) {
        const h = (msg.id ? cardHeights.get(msg.id) : undefined)
          ?? estimateCardHeight(msg.text, cols)
        heights.push(h)
        totalHeight += h
      }

      // 2. maxScroll：可滚动的最大偏移量
      const maxScroll = Math.max(0, totalHeight - viewportHeight)

      // 3. pinned 时用实时计算的 maxScroll（避免 store 中的 scrollOffset 因高度变化而过期）
      const scrollOffset = state.pinned
        ? maxScroll
        : Math.max(0, Math.min(state.scrollOffset, maxScroll))

      // 4. 找 startIndex：从顶部累加高度，找到 scrollOffset 落在哪张卡片
      let cursor = 0
      let startIndex = 0
      const lastIdx = heights.length - 1
      for (let i = 0; i < heights.length; i++) {
        if (cursor + heights[i] > scrollOffset) {
          startIndex = i
          break
        }
        cursor += heights[i]
        startIndex = Math.min(i + 1, lastIdx)
      }

      // 5. topSpacer：startIndex 之前所有卡片的总高度
      const topSpacer = cursor

      // 6. marginTop：首张卡片部分可见时的负偏移，使其正确对齐视口顶部
      const marginTop = -(scrollOffset - topSpacer)

      // 7. 找 endIndex：从 startIndex 累加直到填满 viewportHeight
      let accum = 0
      let endIndex = startIndex + 1
      for (let i = startIndex; i < heights.length; i++) {
        accum += heights[i]
        if (accum >= viewportHeight) {
          endIndex = i + 1
          break
        }
      }

      // 8. overscan：上下各多渲染几张卡片，避免滚动时白屏
      startIndex = Math.max(0, startIndex - OVERSCAN_CARDS)
      endIndex = Math.min(msgs.length, endIndex + OVERSCAN_CARDS)

      // 9. 重新计算 topSpacer（含 overscan）
      let newTopSpacer = 0
      for (let i = 0; i < startIndex; i++) newTopSpacer += heights[i]

      // 10. bottomSpacer：endIndex 之后所有卡片的总高度
      let visibleHeight = 0
      for (let i = startIndex; i < endIndex; i++) visibleHeight += heights[i]
      const bottomSpacer = Math.max(0, totalHeight - newTopSpacer - visibleHeight)

      // 11. 修正 marginTop（相对 overscan 后的 topSpacer）
      const adjustedMarginTop = -(scrollOffset - newTopSpacer)

      return {
        startIndex,
        endIndex,
        topSpacer: newTopSpacer,
        bottomSpacer,
        marginTop: adjustedMarginTop,
        pinned: state.pinned,
        totalHeight,
        maxScroll,
      }
    },
  }
}
