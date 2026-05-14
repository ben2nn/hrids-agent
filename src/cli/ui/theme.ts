// 主题色 tokens —— github-dark 风格
// 参考 DeepSeek-Reasonix 的色调体系

/** 前景色 */
export const FG = {
  strong: '#e6edf3',   // 标题、粗体
  body:   '#c9d1d9',   // 正文
  sub:    '#8b949e',   // 副标题、次要文字
  meta:   '#6e7681',   // 元数据、时间戳
  faint:  '#484f58',   // 省略提示、暗淡文字
} as const

/** 语义色调 */
export const TONE = {
  brand:  '#79c0ff',   // 品牌蓝（流式输出、链接）
  accent: '#d2a8ff',   // 紫色（推理、计划）
  ok:     '#7ee787',   // 绿色（成功、完成）
  warn:   '#f0b07d',   // 橙黄（警告）
  err:    '#ff8b81',   // 红色（错误）
} as const

/** 角色 → 色调映射 */
export const ROLE_TONE = {
  user:      TONE.accent,
  assistant: TONE.ok,
  tool:      TONE.brand,
  system:    FG.sub,
  error:     TONE.err,
} as const

/** 角色 → 图标 glyph */
export const ROLE_GLYPH = {
  user:      '◇',
  assistant: '◈',
  tool:      '▣',
  system:    '●',
  error:     '✖',
} as const

/** 工具状态 → 图标 */
export const TOOL_STATUS_GLYPH = {
  running: '▢',
  ok:      '✓',
  error:   '✖',
  reject:  '✗',
  abort:   '⊘',
} as const

/** 左侧竖条边框样式 */
export const STRIPE_BORDER = {
  topLeft: ' ', top: ' ', topRight: ' ',
  left: '▎',
  right: ' ', bottomLeft: ' ', bottom: ' ', bottomRight: ' ',
} as const
