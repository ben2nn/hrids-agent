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

/** 工具名称 → 显示名称映射 */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // 文件操作
  file_read:   '读取',
  file_write:  '写入',
  file_edit:   '编辑',
  // 搜索
  glob:        '搜索',
  grep:        '搜索',
  // Shell
  bash:        '命令',
  // 计划/任务
  plan_create: '计划',
  plan_update: '计划',
  plan_list:   '计划',
  plan_read:   '计划',
  plan_status: '计划',
  plan_archive:'计划',
  todo_write:  '任务',
  todo_update: '任务',
  todo_append: '任务',
  todo_read:   '任务',
  todo_reset:  '任务',
  // 网络
  web_search:  '搜索',
  web_fetch:   '获取',
  // Agent
  ask_user:    '提问',
  agent:       '代理',
}

/**
 * 获取工具的显示名称
 * 优先使用映射表，否则将 snake_case 转为 Title Case
 */
export function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName]
  // fallback: snake_case → Title Case
  return toolName
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
