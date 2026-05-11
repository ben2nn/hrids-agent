/**
 * InkRenderer — Cell-level diff renderer with DEC 2026 synchronized output.
 *
 * 拦截 Ink 的 stdout 输出，解析为 cell 网格，逐 cell diff 后写入真实终端。
 * 参考 claude-code 的双缓冲 + DEC 2026 方案。
 *
 * 架构：
 *   Ink → stdout wrapper → 帧缓冲 → ANSI 解析 → cell grid → diff → 真实 stdout
 */

// ── ANSI 解析 ───────────────────────────────────────────────────────────────

interface Cell {
  char: string
  styles: string[]   // ANSI SGR 参数列表，如 ['1', '31'] = bold red
}

interface CellGrid {
  rows: number
  cols: number
  cells: Cell[][]    // cells[y][x]
}

/** 空 cell */
const EMPTY_CELL: Cell = { char: ' ', styles: [] }

/** 创建空的 cell grid */
function createGrid(rows: number, cols: number): CellGrid {
  const cells: Cell[][] = []
  for (let y = 0; y < rows; y++) {
    cells[y] = []
    for (let x = 0; x < cols; x++) {
      cells[y][x] = { ...EMPTY_CELL }
    }
  }
  return { rows, cols, cells }
}

/** 深拷贝 grid */
function cloneGrid(grid: CellGrid): CellGrid {
  const cells: Cell[][] = []
  for (let y = 0; y < grid.rows; y++) {
    cells[y] = grid.cells[y].map(c => ({ ...c }))
  }
  return { rows: grid.rows, cols: grid.cols, cells }
}

/**
 * 将 ANSI 字符串解析为 cell grid。
 * 追踪光标位置，处理 SGR 样式、光标移动、擦除序列。
 */
function parseAnsiToGrid(output: string, cols: number, rows: number): CellGrid {
  const grid = createGrid(rows, cols)
  let x = 0
  let y = 0
  let currentStyles: string[] = []
  let i = 0

  while (i < output.length) {
    const ch = output[i]

    // ESC 序列
    if (ch === '\x1b' && output[i + 1] === '[') {
      // 收集 CSI 参数
      let j = i + 2
      while (j < output.length && ((output.charCodeAt(j) >= 0x30 && output.charCodeAt(j) <= 0x3f) || output[j] === '?')) {
        j++
      }
      // 中间字节
      while (j < output.length && output.charCodeAt(j) >= 0x20 && output.charCodeAt(j) <= 0x2f) {
        j++
      }
      // 终止字节
      if (j < output.length) {
        const terminator = output[j]
        const params = output.slice(i + 2, j)

        switch (terminator) {
          case 'm': // SGR — Select Graphic Rendition
            if (params === '' || params === '0') {
              currentStyles = []
            } else {
              currentStyles = params.split(';')
            }
            break
          case 'H': { // CUP — Cursor Position
            const parts = params.split(';')
            const ny = parts[0] ? parseInt(parts[0], 10) - 1 : 0
            const nx = parts[1] ? parseInt(parts[1], 10) - 1 : 0
            x = Math.min(nx, cols - 1)
            y = Math.min(ny, rows - 1)
            break
          }
          case 'A': // CUU — Cursor Up
            y = Math.max(0, y - (parseInt(params, 10) || 1))
            break
          case 'B': // CUD — Cursor Down
            y = Math.min(rows - 1, y + (parseInt(params, 10) || 1))
            break
          case 'C': // CUF — Cursor Forward
            x = Math.min(cols - 1, x + (parseInt(params, 10) || 1))
            break
          case 'D': // CUB — Cursor Back
            x = Math.max(0, x - (parseInt(params, 10) || 1))
            break
          case 'G': // CHA — Cursor Horizontal Absolute
            x = Math.min(cols - 1, (parseInt(params, 10) || 1) - 1)
            break
          case 'J': // ED — Erase in Display
            if (params === '2' || params === '3') {
              // 清屏
              for (let gy = 0; gy < rows; gy++) {
                for (let gx = 0; gx < cols; gx++) {
                  grid.cells[gy][gx] = { ...EMPTY_CELL }
                }
              }
              x = 0; y = 0
            }
            break
          case 'K': // EL — Erase in Line
            if (params === '' || params === '0') {
              // 从光标到行尾
              for (let gx = x; gx < cols; gx++) {
                grid.cells[y][gx] = { ...EMPTY_CELL }
              }
            } else if (params === '2') {
              // 整行
              for (let gx = 0; gx < cols; gx++) {
                grid.cells[y][gx] = { ...EMPTY_CELL }
              }
            }
            break
          // 忽略其他 CSI 序列
        }
        i = j + 1
        continue
      }
    }

    // OSC 序列 (ESC ]) — 跳过直到 ST (\x1b\\) 或 BEL (\x07)
    if (ch === '\x1b' && output[i + 1] === ']') {
      let j = i + 2
      while (j < output.length) {
        if (output[j] === '\x07') { j++; break }
        if (output[j] === '\x1b' && output[j + 1] === '\\') { j += 2; break }
        j++
      }
      i = j
      continue
    }

    // 普通字符
    if (ch === '\n') {
      x = 0
      y = Math.min(y + 1, rows - 1)
      i++
      continue
    }
    if (ch === '\r') {
      x = 0
      i++
      continue
    }
    if (ch === '\t') {
      x = Math.min(x + (8 - (x % 8)), cols - 1)
      i++
      continue
    }
    // 跳过其他控制字符
    if (ch.charCodeAt(0) < 0x20 && ch !== '\x1b') {
      i++
      continue
    }

    // 可见字符（含 CJK 宽字符）
    if (y >= 0 && y < rows && x >= 0 && x < cols) {
      grid.cells[y][x] = { char: ch, styles: [...currentStyles] }
      // CJK 宽字符占 2 列
      if (isWideChar(ch)) {
        if (x + 1 < cols) {
          grid.cells[y][x + 1] = { char: '', styles: [...currentStyles] } // 占位
        }
        x = Math.min(x + 2, cols - 1)
      } else {
        x = Math.min(x + 1, cols - 1)
      }
    }
    i++
  }

  return grid
}

/** 判断是否为 CJK 宽字符（占 2 列） */
function isWideChar(ch: string): boolean {
  const code = ch.codePointAt(0)!
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals, Kangxi, etc.
    (code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, CJK compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ext A
    (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
    (code >= 0xfe10 && code <= 0xfe6f) || // CJK Compat Forms
    (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
    (code >= 0x20000 && code <= 0x2fa1f) // CJK Ext B-G
  )
}

// ── Cell Diff ───────────────────────────────────────────────────────────────

interface DiffPatch {
  x: number
  y: number
  char: string
  styles: string[]
}

/**
 * 比较两个 cell grid，返回需要更新的 cell 列表。
 * 优化：连续的同一行变更合并为连续输出（减少 cursorTo 调用）。
 */
function diffGrids(prev: CellGrid, next: CellGrid): DiffPatch[] {
  const patches: DiffPatch[] = []
  const rows = Math.min(prev.rows, next.rows)
  const cols = Math.min(prev.cols, next.cols)

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = prev.cells[y][x]
      const b = next.cells[y][x]
      if (a.char !== b.char || a.styles.join(';') !== b.styles.join(';')) {
        patches.push({ x, y, ...b })
      }
    }
  }

  return patches
}

// ── ANSI 输出生成 ───────────────────────────────────────────────────────────

const ESC = '\x1b'
const CSI = `${ESC}[`
const BSU = `${ESC}[?2026h`  // Begin Synchronized Update
const ESU = `${ESC}[?2026l`  // End Synchronized Update

/** 生成 SGR 序列 */
function sgr(styles: string[]): string {
  if (styles.length === 0) return `${CSI}0m`
  return `${CSI}${styles.join(';')}m`
}

/** 生成光标定位序列 */
function cursorTo(x: number, y: number): string {
  return `${CSI}${y + 1};${x + 1}H`
}

/** 生成擦除行序列 */
function eraseLines(count: number): string {
  let s = ''
  for (let i = 0; i < count; i++) {
    s += `${CSI}2K`   // 擦除整行
    if (i < count - 1) s += `${CSI}1A` // 光标上移
  }
  s += `${CSI}G`      // 光标移到行首
  return s
}

/**
 * 将 diff patches 转为 ANSI 输出字符串。
 * 优化：相邻的同 style 连续 cell 合并为一次输出。
 */
function patchesToAnsi(patches: DiffPatch[]): string {
  if (patches.length === 0) return ''

  let out = ''
  let lastStyle = ''
  let lastX = -2
  let lastY = -1

  for (const p of patches) {
    const styleKey = p.styles.join(';')

    // 如果不连续或 style 变化，需要重新定位光标
    if (p.y !== lastY || p.x !== lastX + 1 || styleKey !== lastStyle) {
      out += cursorTo(p.x, p.y)
      if (styleKey !== lastStyle) {
        out += sgr(p.styles)
      }
    }

    out += p.char
    lastX = p.x
    lastY = p.y
    lastStyle = styleKey
  }

  // 重置样式
  if (lastStyle) {
    out += `${CSI}0m`
  }

  return out
}

// ── InkRenderer ─────────────────────────────────────────────────────────────

export class InkRenderer {
  private realStdout: NodeJS.WriteStream
  private prevGrid: CellGrid | null = null
  private buffer = ''
  private flushScheduled = false
  private frameCount = 0
  private cursorHidden = false

  /** 帧缓冲超时（ms）：超过此时间未收到新 write 则认为一帧结束 */
  private static FRAME_TIMEOUT_MS = 5

  constructor(stdout: NodeJS.WriteStream) {
    this.realStdout = stdout
  }

  /** 创建一个代理 stdout 流，传给 Ink 的 render() */
  createProxyStream(): NodeJS.WriteStream {
    const self = this
    const proxy = Object.create(this.realStdout)

    proxy.write = function (chunk: any, ...args: any[]): boolean {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      self.bufferWrite(text)
      return true
    }

    return proxy
  }

  /** 缓冲写入，按微任务 + 超时 双重机制 flush */
  private bufferWrite(text: string) {
    this.buffer += text

    if (!this.flushScheduled) {
      this.flushScheduled = true
      // 微任务：同 tick 内的所有 write 合并为一帧
      queueMicrotask(() => this.tryFlush())
      // 超时兜底：防止微任务被长时间阻塞
      setTimeout(() => this.tryFlush(), InkRenderer.FRAME_TIMEOUT_MS)
    }
  }

  private tryFlush() {
    if (!this.flushScheduled) return
    // 等微任务和超时都触发后再 flush（确保同 tick 的 write 全部到齐）
    // 实际上 queueMicrotask 总是在 setTimeout 之前执行，所以这里直接 flush
    this.flushScheduled = false
    this.flush()
  }

  /** 解析缓冲区 → cell grid → diff → 写入真实终端 */
  private flush() {
    const output = this.buffer
    if (!output) return
    this.buffer = ''

    const cols = this.realStdout.columns || 80
    const rows = this.realStdout.rows || 24

    // 解析 ANSI 输出为 cell grid
    const newGrid = parseAnsiToGrid(output, cols, rows)

    if (!this.prevGrid) {
      // 第一帧：全量输出（无 diff），包裹 DEC 2026
      const fullOutput = cursorTo(0, 0) + gridToAnsiFull(newGrid)
      this.realStdout.write(BSU + fullOutput + ESU)
      this.prevGrid = cloneGrid(newGrid)
      this.frameCount++
      return
    }

    // Diff
    const patches = diffGrids(this.prevGrid, newGrid)

    if (patches.length === 0) {
      // 无变化，跳过写入
      this.frameCount++
      return
    }

    // 生成增量 ANSI 输出，包裹 DEC 2026
    const diffOutput = patchesToAnsi(patches)
    this.realStdout.write(BSU + diffOutput + ESU)

    this.prevGrid = cloneGrid(newGrid)
    this.frameCount++
  }

  /** 隐藏光标 */
  hideCursor() {
    if (!this.cursorHidden) {
      this.realStdout.write(`${CSI}?25l`)
      this.cursorHidden = true
    }
  }

  /** 显示光标 */
  showCursor() {
    if (this.cursorHidden) {
      this.realStdout.write(`${CSI}?25h`)
      this.cursorHidden = false
    }
  }

  /** 清屏并重置 */
  clear() {
    this.realStdout.write(`${CSI}2J${CSI}H`)
    this.prevGrid = null
    this.buffer = ''
    this.frameCount = 0
  }

  /** 强制重绘下一帧（清除缓存的 prevGrid） */
  forceRedraw() {
    this.prevGrid = null
  }

  /** 获取统计信息 */
  getStats() {
    return { frameCount: this.frameCount }
  }
}

/** 将 cell grid 全量转为 ANSI 字符串（用于第一帧） */
function gridToAnsiFull(grid: CellGrid): string {
  let out = ''
  let lastStyle = ''

  for (let y = 0; y < grid.rows; y++) {
    if (y > 0) out += '\n'
    out += `${CSI}G` // 行首
    for (let x = 0; x < grid.cols; x++) {
      const cell = grid.cells[y][x]
      const styleKey = cell.styles.join(';')
      if (styleKey !== lastStyle) {
        out += sgr(cell.styles)
        lastStyle = styleKey
      }
      out += cell.char || ' '
    }
  }

  if (lastStyle) out += `${CSI}0m`
  return out
}
