import { describe, it, expect } from 'vitest'
import { createScrollStore } from '../../src/cli/ui/terminal/scroll-store.js'

describe('scroll store', () => {
  it('starts from bottom when leaving pinned mode', () => {
    const store = createScrollStore()

    store.setMaxScroll(20)
    expect(store.getState().scrollOffset).toBe(20)
    expect(store.getState().pinned).toBe(true)

    store.setPinned(false)
    expect(store.getState().scrollOffset).toBe(20)
    expect(store.getState().pinned).toBe(false)

    store.scroll(3)
    expect(store.getState().scrollOffset).toBe(17)
    expect(store.getState().pinned).toBe(false)
  })

  it('keeps the view at bottom when scrollToBottom is called', () => {
    const store = createScrollStore()

    store.setMaxScroll(12)
    store.setPinned(false)
    store.scroll(4)
    expect(store.getState().scrollOffset).toBe(8)

    store.scrollToBottom()
    expect(store.getState().scrollOffset).toBe(12)
    expect(store.getState().pinned).toBe(true)
  })
})
