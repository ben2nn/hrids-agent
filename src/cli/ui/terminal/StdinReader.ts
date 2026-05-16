// StdinReader —— 底层终端输入解析
export interface KeyEvent {
  name: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  sequence: string
  paste?: boolean
  pasteContent?: string
}

type KeyHandler = (key: KeyEvent) => void

export class StdinReader {
  private handlers: Set<KeyHandler> = new Set()
  private pasteBuffer: string = ''
  private inPaste: boolean = false
  private destroyed = false
  private boundHandler: ((data: string) => void) | null = null
  // CSI 序列缓冲：处理 Windows ConPTY 分包发送的情况
  private csiBuffer: string = ''
  private csiTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf-8')
      this.boundHandler = this.handleData.bind(this)
      process.stdin.on('data', this.boundHandler)
    }
  }

  subscribe(handler: KeyHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private handleData(data: string) {
    if (this.destroyed) return

    // 如果 CSI 缓冲区有未完成的序列，先拼接
    if (this.csiBuffer) {
      data = this.csiBuffer + data
      this.csiBuffer = ''
      if (this.csiTimer) { clearTimeout(this.csiTimer); this.csiTimer = null }
    }

    if (data === '\x1b[200~') { this.inPaste = true; this.pasteBuffer = ''; return }
    if (data === '\x1b[201~') {
      this.inPaste = false
      this.emit({ name: 'paste', ctrl: false, shift: false, alt: false, meta: false, sequence: this.pasteBuffer, paste: true, pasteContent: this.pasteBuffer })
      return
    }
    if (this.inPaste) { this.pasteBuffer += data; return }

    const key = this.parseKey(data)
    if (key) {
      this.emit(key)
    }
  }

  private parseKey(data: string): KeyEvent | null {
    const base = { ctrl: false, shift: false, alt: false, meta: false }
    if (data === '\x03') return { ...base, name: 'c', ctrl: true, sequence: data }
    if (data === '\x04') return { ...base, name: 'd', ctrl: true, sequence: data }
    if (data === '\r' || data === '\n') return { ...base, name: 'enter', sequence: data }
    if (data === '\t') return { ...base, name: 'tab', shift: false, sequence: data }
    if (data === '\x7f' || data === '\b') return { ...base, name: 'backspace', sequence: data }
    if (data === '\x1b') return { ...base, name: 'escape', sequence: data }
    if (data.startsWith('\x1b[')) return this.parseCSI(data, base)
    if (data.startsWith('\x1b') && data.length === 2) return { ...base, name: data[1], alt: true, sequence: data }
    if (data.length === 1) {
      const code = data.charCodeAt(0)
      if (code >= 0x01 && code <= 0x1a) return { ...base, name: String.fromCharCode(code + 96), ctrl: true, sequence: data }
      return { ...base, name: data, sequence: data }
    }
    return { ...base, name: 'paste', sequence: data, paste: true, pasteContent: data }
  }

  private parseCSI(data: string, base: Omit<KeyEvent, 'name' | 'sequence'>): KeyEvent | null {
    const seq = data.slice(2)

    // 不完整 CSI 序列（没有终结字符 a-z/A-Z/~），缓冲等待后续数据
    if (!/[a-zA-Z~]$/.test(seq)) {
      this.csiBuffer = data
      this.csiTimer = setTimeout(() => {
        // 超时：将缓冲内容作为原始按键处理
        const buffered = this.csiBuffer
        this.csiBuffer = ''
        this.csiTimer = null
        if (buffered) this.emitRaw(buffered)
      }, 50)
      return null
    }

    if (seq === 'A') return { ...base, name: 'up', sequence: data }
    if (seq === 'B') return { ...base, name: 'down', sequence: data }
    if (seq === 'C') return { ...base, name: 'right', sequence: data }
    if (seq === 'D') return { ...base, name: 'left', sequence: data }
    if (seq === 'H') return { ...base, name: 'home', sequence: data }
    if (seq === 'F') return { ...base, name: 'end', sequence: data }
    if (seq === '3~') return { ...base, name: 'delete', sequence: data }
    if (seq === '5~') return { ...base, name: 'pageup', sequence: data }
    if (seq === '6~') return { ...base, name: 'pagedown', sequence: data }
    if (seq === 'Z') return { ...base, name: 'tab', shift: true, sequence: data }
    return null
  }

  private emitRaw(data: string) {
    const key = this.parseKey(data)
    if (key) this.emit(key)
  }

  private emit(key: KeyEvent) {
    for (const handler of this.handlers) handler(key)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
    if (this.csiTimer) { clearTimeout(this.csiTimer); this.csiTimer = null }
    if (this.boundHandler) {
      process.stdin.off('data', this.boundHandler)
      this.boundHandler = null
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
  }
}

let instance: StdinReader | null = null
export function getStdinReader(): StdinReader {
  if (!instance || instance.isDestroyed()) instance = new StdinReader()
  return instance
}
