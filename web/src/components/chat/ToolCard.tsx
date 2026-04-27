import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { getFileContent, getGitFileContent } from '../../lib/gateway.js'

// ─── 工具名称映射 ──────────────────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, { label: string; icon: string }> = {
  file_read:          { label: '读取文件',     icon: 'file-text' },
  file_write:         { label: '写入文件',     icon: 'file-edit' },
  file_edit:          { label: '编辑文件',     icon: 'file-edit' },
  glob:               { label: '查找文件',     icon: 'search' },
  grep:               { label: '搜索内容',     icon: 'search' },
  web_search:         { label: '网络搜索',     icon: 'globe' },
  web_fetch:          { label: '获取网页',     icon: 'globe' },
  bash:               { label: '执行命令',     icon: 'terminal' },
  powershell:         { label: '执行命令',     icon: 'terminal' },
  todo_write:         { label: '更新任务',     icon: 'check-square' },
  todo_read:          { label: '查看任务',     icon: 'check-square' },
  ask_user:           { label: '询问用户',     icon: 'message-circle' },
  request_decision:   { label: '请求决策',     icon: 'message-circle' },
  skill:              { label: '调用技能',     icon: 'zap' },
  skill_list:         { label: '列出技能',     icon: 'zap' },
  skill_save:         { label: '保存技能',     icon: 'zap' },
  skillhub_search:    { label: '搜索技能库',   icon: 'search' },
  skillhub_install:   { label: '安装技能',     icon: 'package' },
  skillhub_uninstall: { label: '卸载技能',     icon: 'package' },
  skillhub_upgrade:   { label: '升级技能',     icon: 'package' },
  skillhub_list:      { label: '已装技能',     icon: 'package' },
  skillhub_config:    { label: '技能库配置',   icon: 'settings' },
  skillhub_setup:     { label: '安装 CLI',     icon: 'settings' },
  skillhub_recommend: { label: '推荐技能',     icon: 'zap' },
  schedule_cron:      { label: '定时任务',     icon: 'clock' },
  agent:              { label: '子智能体',     icon: 'cpu' },
  agent_spawn:        { label: '派生智能体',   icon: 'cpu' },
  team_create:        { label: '创建团队',     icon: 'cpu' },
  team_delete:        { label: '解散团队',     icon: 'cpu' },
  team_status:        { label: '团队状态',     icon: 'cpu' },
  team_wait:          { label: '等待团队',     icon: 'cpu' },
  send_message:       { label: '发送消息',     icon: 'message-circle' },
  receive_message:    { label: '接收消息',     icon: 'message-circle' },
}

// ─── SVG 图标（Lucide 风格，16×16） ───────────────────────────────────────

function Icon({ name, size = 13, className = '' }: { name: string; size?: number; className?: string }) {
  const s = size
  const props = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className }
  switch (name) {
    case 'file-text':    return <svg {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
    case 'file-edit':    return <svg {...props}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    case 'search':       return <svg {...props}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    case 'globe':        return <svg {...props}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
    case 'terminal':     return <svg {...props}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
    case 'check-square': return <svg {...props}><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    case 'message-circle':return <svg {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    case 'zap':          return <svg {...props}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    case 'package':      return <svg {...props}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
    case 'settings':     return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    case 'clock':        return <svg {...props}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    case 'cpu':          return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
    case 'chevron-right':return <svg {...props}><polyline points="9 18 15 12 9 6"/></svg>
    case 'chevron-down': return <svg {...props}><polyline points="6 9 12 15 18 9"/></svg>
    case 'wrench':       return <svg {...props}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
    default:             return <svg {...props}><circle cx="12" cy="12" r="3"/></svg>
  }
}

function resolveToolMeta(toolName: string) {
  const m = TOOL_NAME_MAP[toolName]
  return { label: m?.label ?? toolName, iconName: m?.icon ?? 'wrench' }
}

// ─── 工具描述摘要（标题行右侧的灰色文字） ─────────────────────────────────

function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  switch (toolName) {
    case 'file_read':
    case 'file_write':
    case 'file_edit':   return String(inp.path ?? '')
    case 'glob':        return String(inp.pattern ?? '')
    case 'grep':        return String(inp.pattern ?? '')
    case 'web_search':  return String(inp.query ?? '')
    case 'web_fetch':   return String(inp.url ?? '')
    case 'bash':
    case 'powershell': {
      const cmd = String(inp.command ?? inp.cmd ?? '')
      return cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd
    }
    case 'ask_user':    return String(inp.question ?? '')
    case 'todo_write': {
      const todos = Array.isArray(inp.todos) ? inp.todos as Array<Record<string, unknown>> : []
      if (todos.length === 0) return ''
      const done = todos.filter(t => t.status === 'completed').length
      const active = todos.filter(t => t.status === 'in_progress').length
      return `${todos.length} 项 · ${done} 已完成${active ? ` · ${active} 进行中` : ''}`
    }
    case 'todo_read':   return ''
    default:            return ''
  }
}

// ─── Props ─────────────────────────────────────────────────────────────────

interface ToolCardProps {
  toolName: string
  input: unknown
  status: 'pending' | 'success' | 'error' | 'denied'
  logs: string[]
  result?: unknown
  isExpanded?: boolean
  onToggle?: () => void
  /** 所属会话 ID，用于文件内容 API */
  sessionId?: string
}

// ─── 状态指示点 ────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: ToolCardProps['status'] }) {
  if (status === 'pending') {
    return (
      <svg className="animate-spin shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: 'var(--text-muted)' }}>
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    )
  }
  if (status === 'success') {
    return (
      <svg className="shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--success)' }}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg className="shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: 'var(--error)' }}>
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    )
  }
  if (status === 'denied') {
    return (
      <svg className="shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--warning)' }}>
        <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    )
  }
  return null
}

// ─── web_search 结果 ───────────────────────────────────────────────────────

interface SearchResultItem { title: string; snippet: string; url: string }

function parseWebSearchResult(raw: string): SearchResultItem[] | null {
  if (!raw.includes('---') || !raw.includes('**')) return null
  const blocks = raw.split(/\n---+\n/).map(b => b.trim()).filter(Boolean)
  const items: SearchResultItem[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    const titleLine = lines.find(l => l.startsWith('**'))
    if (!titleLine) continue
    const title = titleLine.replace(/^\*\*|\*\*$/g, '')
    const urlLine = lines.find(l => l.startsWith('http'))
    const snippet = lines.find(l => l !== titleLine && l !== urlLine) ?? ''
    items.push({ title, snippet, url: urlLine ?? '' })
  }
  return items.length > 0 ? items : null
}

function WebSearchResult({ result }: { result: unknown }) {
  const raw = typeof result === 'string' ? result : JSON.stringify(result)
  const items = parseWebSearchResult(raw)
  if (!items) {
    return (
      <p className="text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
        {raw.length > 800 ? raw.slice(0, 800) + `\n…（共 ${raw.length} 字符）` : raw}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2 py-1.5 border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="text-[10px] tabular-nums mt-0.5 shrink-0 w-3" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-xs font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>{item.title}</span>
            {item.snippet && <span className="text-[11px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{item.snippet}</span>}
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener noreferrer"
                className="text-[10px] truncate hover:underline"
                style={{ color: 'var(--accent)' }} title={item.url}>
                {item.url}
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── web_fetch 结果 ────────────────────────────────────────────────────────

function WebFetchResult({ result, input }: { result: unknown; input: unknown }) {
  const raw = typeof result === 'string' ? result : JSON.stringify(result)
  const url = (input && typeof input === 'object') ? (input as Record<string, unknown>).url as string : ''
  const isTruncated = raw.includes('[内容已截断，共')
  const bodyEnd = raw.lastIndexOf('\n\n[内容已截断')
  const body = bodyEnd > 0 ? raw.slice(0, bodyEnd) : raw
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="text-[11px] truncate max-w-[280px] hover:underline"
            style={{ color: 'var(--accent)' }} title={url}>{url}</a>
        )}
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {raw.length.toLocaleString()} 字符{isTruncated ? '（已截断）' : ''}
        </span>
      </div>
      <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded-md px-2.5 py-2"
        style={{ color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.15)' }}>
        {body.slice(0, 600)}{body.length > 600 ? `\n…（共 ${body.length.toLocaleString()} 字符）` : ''}
      </pre>
    </div>
  )
}

// ─── glob 查找文件结果 ─────────────────────────────────────────────────────

function GlobResult({ result, input }: { result: unknown; input?: unknown }) {
  const raw = typeof result === 'string' ? result : JSON.stringify(result)
  const inp = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const pattern = String(inp.pattern ?? '')
  const cwd = String(inp.cwd ?? '')

  // 解析文件列表：换行分隔 或 JSON 数组
  let files: string[] = []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) files = parsed.map(String)
  } catch {
    files = raw.split('\n').map(s => s.trim()).filter(Boolean)
  }

  // 条件块
  const conditionBlock = (pattern || cwd) && (
    <div className="flex flex-col gap-1 mb-2">
      {pattern && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-10 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>模式</span>
          <code className="font-mono px-1.5 py-0.5 rounded" style={{ color: 'var(--accent)', background: 'var(--bg-tertiary, rgba(0,0,0,0.18))' }}>{pattern}</code>
        </div>
      )}
      {cwd && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-10 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>路径</span>
          <code className="font-mono" style={{ color: 'var(--text-secondary)' }}>{cwd}</code>
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 4 }} />
    </div>
  )

  if (files.length === 0) {
    return (
      <div>
        {conditionBlock}
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>未找到匹配的文件</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {conditionBlock}
      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {files.length} 个文件
      </span>
      <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
        <div className="max-h-48 overflow-y-auto">
          {files.map((file, i) => {
            const parts = file.replace(/\\/g, '/').split('/')
            const name = parts.pop() ?? file
            const dir = parts.join('/')
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-2.5 py-1.5 border-b last:border-b-0"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <Icon name="file-text" size={11} className="shrink-0" />
                <span className="text-[11px] font-mono truncate flex-1 min-w-0" style={{ color: 'var(--text-primary)' }} title={file}>
                  {name}
                </span>
                {dir && (
                  <span className="text-[10px] font-mono truncate shrink-0 max-w-[40%]" style={{ color: 'var(--text-muted)' }} title={dir}>
                    {dir}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── grep 搜索内容结果 ─────────────────────────────────────────────────────

interface GrepMatch {
  file: string
  line: number
  text: string
}

function parseGrepResult(raw: string): GrepMatch[] | null {
  // 支持两种格式：
  // 1. "文件:行号:内容" (ripgrep 默认格式)
  // 2. JSON 数组
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((item: Record<string, unknown>) => ({
        file: String(item.file ?? item.path ?? ''),
        line: Number(item.line ?? item.lineNumber ?? 0),
        text: String(item.text ?? item.content ?? item.match ?? ''),
      })).filter(m => m.file || m.text)
    }
  } catch { /* 不是 JSON，继续尝试文本解析 */ }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const matches: GrepMatch[] = []
  for (const line of lines) {
    // 格式：path/to/file.ts:42:  const foo = bar
    const m = line.match(/^(.+?):(\d+):(.*)$/)
    if (m) {
      matches.push({ file: m[1], line: parseInt(m[2], 10), text: m[3] })
    }
  }
  return matches.length > 0 ? matches : null
}

function GrepResult({ result, input }: { result: unknown; input: unknown }) {
  const raw = typeof result === 'string' ? result : JSON.stringify(result)
  const inp = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const pattern = String(inp.pattern ?? '')
  const searchPath = String(inp.path ?? '')
  const include = String(inp.include ?? '')
  const caseSensitive = inp.caseSensitive === true
  const matches = parseGrepResult(raw)

  // 条件块（复用）
  const conditionBlock = (
    <div className="flex flex-col gap-1">
      {pattern && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-10 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>关键词</span>
          <code className="font-mono px-1.5 py-0.5 rounded" style={{ color: 'var(--accent)', background: 'var(--bg-tertiary, rgba(0,0,0,0.18))' }}>{pattern}</code>
        </div>
      )}
      {searchPath && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-10 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>路径</span>
          <code className="font-mono" style={{ color: 'var(--text-secondary)' }}>{searchPath}</code>
        </div>
      )}
      {include && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-10 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>类型</span>
          <code className="font-mono px-1 py-0.5 rounded" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>{include}</code>
        </div>
      )}
      {caseSensitive && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-10 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>大小写</span>
          <span style={{ color: 'var(--text-secondary)' }}>区分</span>
        </div>
      )}
    </div>
  )

  if (!matches) {
    const isEmpty = raw.trim() === '' || raw.trim() === '[]' || raw.includes('No matches') || raw.includes('未找到')
    if (isEmpty) {
      return (
        <div className="flex flex-col gap-2">
          {conditionBlock}
          <div style={{ borderTop: '1px solid var(--border-subtle)' }} />
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>未找到匹配内容</span>
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-2">
        {conditionBlock}
        <div style={{ borderTop: '1px solid var(--border-subtle)' }} />
        <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto rounded-md px-2.5 py-2"
          style={{ color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.15)' }}>
          {raw.length > 600 ? raw.slice(0, 600) + `\n…（共 ${raw.length} 字符）` : raw}
        </pre>
      </div>
    )
  }

  // 按文件分组
  const byFile = new Map<string, GrepMatch[]>()
  for (const m of matches) {
    const key = m.file || '(未知文件)'
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key)!.push(m)
  }

  const fileCount = byFile.size
  const matchCount = matches.length

  return (
    <div className="flex flex-col gap-2">
      {/* 搜索条件（带字段说明） */}
      {conditionBlock}

      {/* 分隔线 */}
      <div style={{ borderTop: '1px solid var(--border-subtle)' }} />

      {/* 统计 */}
      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {fileCount} 个文件 · {matchCount} 处匹配
      </span>

      {/* 按文件分组展示 */}
      <div className="rounded-md overflow-hidden max-h-64 overflow-y-auto" style={{ border: '1px solid var(--border-subtle)' }}>
        {Array.from(byFile.entries()).map(([file, fileMatches]) => {
          const parts = file.replace(/\\/g, '/').split('/')
          const fileName = parts.pop() ?? file
          const dir = parts.join('/')
          return (
            <div key={file} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
              {/* 文件名 */}
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 sticky top-0" style={{ background: 'var(--bg-secondary)' }}>
                <Icon name="file-text" size={11} className="shrink-0" />
                <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--text-primary)' }}>{fileName}</span>
                {dir && <span className="text-[10px] font-mono truncate flex-1 min-w-0" style={{ color: 'var(--text-muted)' }}>{dir}</span>}
                <span className="ml-auto text-[10px] tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>{fileMatches.length}</span>
              </div>
              {/* 匹配行 */}
              {fileMatches.map((m, i) => (
                <div key={i} className="flex items-baseline gap-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  {m.line > 0 && (
                    <span className="text-[10px] font-mono tabular-nums shrink-0 px-2 py-1 text-right select-none w-10" style={{ color: 'var(--text-muted)', background: 'rgba(0,0,0,0.06)', borderRight: '1px solid var(--border-subtle)' }}>
                      {m.line}
                    </span>
                  )}
                  <span className="text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed flex-1 min-w-0 px-2.5 py-1" style={{ color: 'var(--text-secondary)' }}>
                    {m.text.trim()}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── todo_write / todo_read 任务列表展示 ──────────────────────────────────

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

function parseTodos(input: unknown, result: unknown): TodoItem[] | null {
  // 优先从 input.todos 解析（最准确）
  if (input && typeof input === 'object') {
    const inp = input as Record<string, unknown>
    if (Array.isArray(inp.todos)) {
      return inp.todos.map((t: Record<string, unknown>) => ({
        id: String(t.id ?? ''),
        content: String(t.content ?? t.task ?? ''),
        status: (t.status as TodoItem['status']) ?? 'pending',
        priority: (t.priority as TodoItem['priority']) ?? 'medium',
      }))
    }
  }
  // 降级：从 result 文本解析
  const raw = typeof result === 'string' ? result : JSON.stringify(result)
  const lines = raw.split('\n').filter(l => /^[✓▸○]/.test(l.trim()))
  if (lines.length === 0) return null
  return lines.map((line, i) => {
    const completed = line.includes('✓')
    const inProgress = line.includes('▸')
    const status: TodoItem['status'] = completed ? 'completed' : inProgress ? 'in_progress' : 'pending'
    const priorityMatch = line.match(/\[(high|medium|low)\]/)
    const priority = (priorityMatch?.[1] as TodoItem['priority']) ?? 'medium'
    const content = line.replace(/^[✓▸○]\s*/, '').replace(/\[(high|medium|low)\]\s*/, '').trim()
    return { id: String(i + 1), content, status, priority }
  })
}

const PRIORITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' }
const PRIORITY_COLOR: Record<string, string> = {
  high: 'var(--error, #f87171)',
  medium: 'var(--warning, #fb923c)',
  low: 'var(--text-muted)',
}

function TodoResult({ input, result }: { input: unknown; result: unknown }) {
  const todos = parseTodos(input, result)
  if (!todos || todos.length === 0) return <GenericResult result={result} />

  const completed = todos.filter(t => t.status === 'completed').length
  const inProgress = todos.filter(t => t.status === 'in_progress').length
  const pending = todos.filter(t => t.status === 'pending').length

  return (
    <div className="flex flex-col gap-2">
      {/* 进度统计 */}
      <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>{todos.length} 项任务</span>
        {completed > 0 && <span style={{ color: 'var(--success)' }}>✓ {completed} 已完成</span>}
        {inProgress > 0 && <span style={{ color: 'var(--accent)' }}>▸ {inProgress} 进行中</span>}
        {pending > 0 && <span>{pending} 待处理</span>}
      </div>

      {/* 进度条 */}
      {todos.length > 0 && (
        <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--border-subtle)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.round((completed / todos.length) * 100)}%`, background: 'var(--success)' }}
          />
        </div>
      )}

      {/* 任务列表 */}
      <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
        {todos.map((todo) => {
          const isDone = todo.status === 'completed'
          const isActive = todo.status === 'in_progress'
          return (
            <div
              key={todo.id}
              className="flex items-start gap-2.5 px-2.5 py-2 border-b last:border-b-0"
              style={{ borderColor: 'var(--border-subtle)', opacity: isDone ? 0.55 : 1 }}
            >
              {/* 状态图标 */}
              <span className="shrink-0 mt-0.5 text-[12px] leading-none select-none" style={{
                color: isDone ? 'var(--success)' : isActive ? 'var(--accent)' : 'var(--text-muted)'
              }}>
                {isDone ? '✓' : isActive ? '▸' : '○'}
              </span>

              {/* 内容 */}
              <span
                className="text-[11px] leading-relaxed flex-1 min-w-0"
                style={{
                  color: isDone ? 'var(--text-muted)' : 'var(--text-primary)',
                  textDecoration: isDone ? 'line-through' : 'none',
                }}
              >
                {todo.content}
              </span>

              {/* 优先级标签 */}
              <span
                className="shrink-0 text-[9px] font-medium px-1 py-0.5 rounded"
                style={{
                  color: PRIORITY_COLOR[todo.priority],
                  border: `1px solid ${PRIORITY_COLOR[todo.priority]}`,
                  opacity: 0.75,
                  lineHeight: 1,
                }}
              >
                {PRIORITY_LABEL[todo.priority]}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── 通用结果 ──────────────────────────────────────────────────────────────

function GenericResult({ result }: { result: unknown }) {
  const str = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  const display = str.length > 600 ? str.slice(0, 600) + `\n…（共 ${str.length} 字符）` : str
  return (
    <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto rounded-md px-2.5 py-2"
      style={{ color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.15)' }}>
      {display}
    </pre>
  )
}

// ─── bash / powershell 终端展示 ────────────────────────────────────────────

function BashBlock({ command, result, status }: { command: string; result: unknown; status: ToolCardProps['status'] }) {
  const output = typeof result === 'string' ? result : result !== undefined ? JSON.stringify(result, null, 2) : ''

  // 解析 exit code（result 可能是 { output, exitCode } 结构）
  let exitCode: number | null = null
  let displayOutput = output
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if ('exitCode' in r) exitCode = Number(r.exitCode)
    if ('output' in r && typeof r.output === 'string') displayOutput = r.output
    else if ('stdout' in r && typeof r.stdout === 'string') displayOutput = r.stdout
  }

  const isTruncated = false
  const visibleOutput = displayOutput

  const promptColor = status === 'error' ? 'var(--error)' : 'var(--success)'

  // 检测主题模式
  const isDark = !document.documentElement.classList.contains('light')

  // 夜晚模式：深色背景 + 亮色文字
  // 白天模式：浅色背景 + 深色文字
  const bgStyle = isDark
    ? { background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.06)' }
    : { background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.08)' }

  const headerStyle = isDark
    ? { background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.06)' }
    : { background: 'rgba(0,0,0,0.02)', borderBottom: '1px solid rgba(0,0,0,0.06)' }

  const commandTextColor = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.8)'
  const outputTextColor = isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)'
  const headerTextColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'

  return (
    <div className="rounded-md overflow-hidden font-mono text-[11px] leading-relaxed"
      style={bgStyle}>

      {/* 终端标题栏 */}
      <div className="flex items-center gap-1.5 px-3 py-1.5" style={headerStyle}>
        <span className="text-[10px]" style={{ color: headerTextColor }}>shell</span>
        {exitCode !== null && (
          <span className="ml-auto text-[10px]" style={{ color: exitCode === 0 ? 'var(--success)' : 'var(--error)' }}>
            exit {exitCode}
          </span>
        )}
      </div>

      {/* 命令行 */}
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1">
        <span className="shrink-0 select-none" style={{ color: promptColor }}>$</span>
        <span className="whitespace-pre-wrap break-all" style={{ color: commandTextColor }}>{command}</span>
      </div>

      {/* 输出区 */}
      {displayOutput && (
        <div className="px-3 pb-2.5 pt-1 max-h-64 overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words m-0" style={{ color: outputTextColor }}>
            {visibleOutput}
            {isTruncated && (
              <span style={{ color: headerTextColor }}>
                {`\n…（已截断，共 ${displayOutput.length.toLocaleString()} 字符）`}
              </span>
            )}
          </pre>
        </div>
      )}

      {/* pending 时的光标动画 */}
      {status === 'pending' && !displayOutput && (
        <div className="px-3 pb-2.5 pt-1">
          <span className="inline-block w-1.5 h-3 rounded-sm animate-pulse" style={{ background: headerTextColor }} />
        </div>
      )}
    </div>
  )
}

// ─── 文件内容弹窗 ──────────────────────────────────────────────────────────

function FileViewerModal({
  sessionId,
  filePath,
  onClose,
}: {
  sessionId: string
  filePath: string   // 相对路径（传给 API）
  onClose: () => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    getFileContent(sessionId, filePath)
      .then(r => setContent(r.content))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [sessionId, filePath])

  // Esc 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // 检测主题模式
  const isDark = !document.documentElement.classList.contains('light')

  // 检测文件扩展名，决定是否语法高亮
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const isCode = ['ts','tsx','js','jsx','py','go','rs','java','c','cpp','h','css','html','json','yaml','yml','toml','sh','bash','md','sql','xml'].includes(ext)

  // 主题相关样式
  const modalBg = isDark ? 'var(--bg-secondary)' : 'rgba(255,255,255,0.95)'
  const lineNumberBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'
  const lineNumberColor = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)'
  const contentColor = isDark ? 'var(--text-primary)' : 'rgba(0,0,0,0.85)'
  const borderColor = isDark ? 'var(--border-subtle)' : 'rgba(0,0,0,0.08)'

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div
        className="flex flex-col rounded-xl overflow-hidden w-full max-w-3xl"
        style={{
          maxHeight: '80vh',
          background: modalBg,
          border: `1px solid ${borderColor}`,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2.5 px-4 py-3 shrink-0" style={{ borderBottom: `1px solid ${borderColor}` }}>
          <Icon name="file-text" size={14} className="" />
          <span className="text-xs font-mono flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
            {filePath}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/[0.06]"
            style={{ color: 'var(--text-muted)' }}
            aria-label="关闭"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-hidden flex">
          {loading && (
            <div className="flex items-center justify-center h-32 w-full" style={{ color: 'var(--text-muted)' }}>
              <svg className="animate-spin mr-2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span className="text-xs">加载中…</span>
            </div>
          )}
          {error && (
            <div className="p-4 text-xs w-full" style={{ color: 'var(--error)' }}>
              读取失败：{error}
            </div>
          )}
          {!loading && !error && content !== null && (
            /* 单一滚动容器，行号和代码横向排列共用同一滚动条 */
            <div className="flex-1 overflow-auto flex">
              {/* 行号列（sticky 固定在左侧） */}
              <div
                className="select-none shrink-0 sticky left-0 z-10"
                style={{ background: lineNumberBg, borderRight: `1px solid ${borderColor}` }}
              >
                <pre className="text-[12px] font-mono leading-relaxed p-4 pr-3 text-right whitespace-pre m-0" style={{ color: lineNumberColor }}>
                  {content.split('\n').map((_, i) => i + 1).join('\n')}
                </pre>
              </div>
              {/* 代码内容 */}
              <div className="flex-1 min-w-0">
                <pre
                  className={`text-[12px] font-mono leading-relaxed p-4 whitespace-pre ${isCode ? 'language-' + ext : ''}`}
                  style={{ color: contentColor, margin: 0 }}
                >
                  {content}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── file_edit 差异弹窗 ────────────────────────────────────────────────────

function DiffModal({ filePath, oldStr, newStr, sessionId, onClose }: {
  filePath: string
  oldStr: string
  newStr: string
  sessionId?: string
  onClose: () => void
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 优先从 git HEAD 获取修改前的原始内容，失败时降级用当前文件 + oldStr 还原
  useEffect(() => {
    if (!sessionId || !filePath) return
    getGitFileContent(sessionId, filePath)
      .then(r => setFileContent(r.content))
      .catch(() => {
        // git 拿不到（新文件 / 非 git 仓库），用当前文件内容 + oldStr 还原
        getFileContent(sessionId, filePath)
          .then(r => {
            // 当前文件是修改后的，用 newStr 定位还原出修改前内容
            const idx = r.content.indexOf(newStr)
            if (idx !== -1) {
              setFileContent(r.content.slice(0, idx) + oldStr + r.content.slice(idx + newStr.length))
            } else {
              setFileContent(r.content)
            }
          })
          .catch(e => setLoadError(String(e)))
      })
  }, [sessionId, filePath, oldStr, newStr])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const isDark = !document.documentElement.classList.contains('light')
  const modalBg = isDark ? 'var(--bg-secondary)' : 'rgba(255,255,255,0.97)'
  const borderColor = isDark ? 'var(--border-subtle)' : 'rgba(0,0,0,0.08)'
  const loading = sessionId && fileContent === null && loadError === null

  // ── 构建 unified diff 行列表 ──────────────────────────────────────────
  type DiffLine =
    | { type: 'context'; oldNo: number; newNo: number; text: string }
    | { type: 'del';     oldNo: number;                text: string }
    | { type: 'add';                    newNo: number; text: string }

  const diffLines = useMemo<DiffLine[]>(() => {
    if (!fileContent) return []

    // fileContent 是修改前的完整文件，直接定位 oldStr
    const idx = fileContent.indexOf(oldStr)
    if (idx === -1) return []

    const before = fileContent.slice(0, idx)
    const after  = fileContent.slice(idx + oldStr.length)

    const beforeLines = before.length > 0 ? before.split('\n') : []
    const afterLines  = after.length > 0  ? after.split('\n')  : []
    const delLines    = oldStr.split('\n')
    const addLines    = newStr.split('\n')

    const result: DiffLine[] = []
    let oldNo = 1
    let newNo = 1

    for (const line of beforeLines) {
      result.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line })
    }
    for (const line of delLines) {
      result.push({ type: 'del', oldNo: oldNo++, text: line })
    }
    for (const line of addLines) {
      result.push({ type: 'add', newNo: newNo++, text: line })
    }
    for (const line of afterLines) {
      result.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line })
    }

    return result
  }, [fileContent, oldStr, newStr])

  // 降级：没有文件内容时直接展示 oldStr / newStr
  const fallbackLines = useMemo<DiffLine[]>(() => {
    const result: DiffLine[] = []
    let oldNo = 1; let newNo = 1
    for (const line of oldStr.split('\n')) result.push({ type: 'del', oldNo: oldNo++, text: line })
    for (const line of newStr.split('\n')) result.push({ type: 'add', newNo: newNo++, text: line })
    return result
  }, [oldStr, newStr])

  const rows = diffLines.length > 0 ? diffLines : fallbackLines

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div
        className="flex flex-col rounded-xl overflow-hidden w-full max-w-5xl"
        style={{ maxHeight: '85vh', background: modalBg, border: `1px solid ${borderColor}`, boxShadow: 'var(--shadow-lg)' }}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2.5 px-4 py-2.5 shrink-0" style={{ borderBottom: `1px solid ${borderColor}` }}>
          <Icon name="file-edit" size={13} />
          <span className="text-[11px] font-mono flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{filePath}</span>
          {loading && (
            <svg className="animate-spin mr-1 shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: 'var(--text-muted)' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          )}
          <button type="button" onClick={onClose} className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/[0.06]" style={{ color: 'var(--text-muted)' }} aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* diff 内容：单列 unified，共用一个滚动条 */}
        <div className="flex-1 min-h-0 relative flex">
          {/* 滚动主体 */}
          <div className="flex-1 overflow-auto font-mono text-[12.5px] leading-[1.6]">
          {loading && (
            <div className="flex items-center justify-center h-32" style={{ color: 'var(--text-muted)' }}>
              <svg className="animate-spin mr-2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span className="text-xs">加载文件内容…</span>
            </div>
          )}
          {loadError && (
            <div className="px-4 py-2 text-xs" style={{ color: 'var(--error)' }}>
              加载失败：{loadError}，仅显示变更片段
            </div>
          )}
          {!loading && (
          <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {/* 旧行号 */}
              <col style={{ width: '2.8rem' }} />
              {/* 新行号 */}
              <col style={{ width: '2.8rem' }} />
              {/* 符号 */}
              <col style={{ width: '1.5rem' }} />
              {/* 代码 */}
              <col />
            </colgroup>
            <tbody>
              {rows.map((row, i) => {
                const isEllipsis = row.type === 'context' && (row as { oldNo: number }).oldNo === 0

                const bg = row.type === 'del'
                  ? (isDark ? 'rgba(239,68,68,0.13)' : 'rgba(239,68,68,0.08)')
                  : row.type === 'add'
                    ? (isDark ? 'rgba(34,197,94,0.11)' : 'rgba(34,197,94,0.06)')
                    : 'transparent'

                const textColor = row.type === 'del'
                  ? (isDark ? 'rgba(252,165,165,0.92)' : 'rgb(153,27,27)')
                  : row.type === 'add'
                    ? (isDark ? 'rgba(134,239,172,0.92)' : 'rgb(20,83,45)')
                    : (isDark ? 'var(--text-primary)' : 'rgba(0,0,0,0.82)')

                const lineNumColor = row.type === 'del'
                  ? (isDark ? 'rgba(239,68,68,0.4)' : 'rgba(185,28,28,0.4)')
                  : row.type === 'add'
                    ? (isDark ? 'rgba(34,197,94,0.4)' : 'rgba(21,128,61,0.4)')
                    : (isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)')

                const lineNumBg = row.type === 'del'
                  ? (isDark ? 'rgba(239,68,68,0.07)' : 'rgba(239,68,68,0.04)')
                  : row.type === 'add'
                    ? (isDark ? 'rgba(34,197,94,0.07)' : 'rgba(34,197,94,0.04)')
                    : (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)')

                const symbol = row.type === 'del' ? '−' : row.type === 'add' ? '+' : ''
                const symbolColor = row.type === 'del'
                  ? (isDark ? 'rgba(239,68,68,0.75)' : 'rgb(185,28,28)')
                  : row.type === 'add'
                    ? (isDark ? 'rgba(34,197,94,0.85)' : 'rgb(21,128,61)')
                    : 'transparent'

                if (isEllipsis) {
                  return (
                    <tr key={i} style={{ background: isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)' }}>
                      <td colSpan={4} className="px-4 py-0.5 select-none text-[11px]" style={{ color: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.28)' }}>
                        {row.text}
                      </td>
                    </tr>
                  )
                }

                return (
                  <tr key={i} style={{ background: bg }}>
                    {/* 旧行号 */}
                    <td className="select-none text-right pr-2 pl-2 py-px text-[11px]" style={{ color: lineNumColor, background: lineNumBg, borderRight: `1px solid ${borderColor}`, verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                      {row.type !== 'add' ? (row as { oldNo: number }).oldNo : ''}
                    </td>
                    {/* 新行号 */}
                    <td className="select-none text-right pr-2 pl-1 py-px text-[11px]" style={{ color: lineNumColor, background: lineNumBg, borderRight: `1px solid ${borderColor}`, verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                      {row.type !== 'del' ? (row as { newNo: number }).newNo : ''}
                    </td>
                    {/* 符号 */}
                    <td className="select-none text-center py-px font-bold" style={{ color: symbolColor, verticalAlign: 'top', fontSize: '13px' }}>
                      {symbol}
                    </td>
                    {/* 代码 */}
                    <td className="px-3 py-px whitespace-pre" style={{ color: textColor, verticalAlign: 'top' }}>
                      {row.text}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          )}
          </div>

          {/* 滚动条旁的变更位置 minimap */}
          {!loading && rows.length > 0 && (
            <div className="shrink-0 w-2 relative select-none" style={{ background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', borderLeft: `1px solid ${borderColor}` }}>
              {rows.map((row, i) => {
                if (row.type === 'context') return null
                const top = `${(i / rows.length) * 100}%`
                const color = row.type === 'add' ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.7)'
                return (
                  <div
                    key={i}
                    className="absolute w-full"
                    style={{ top, height: '2px', background: color }}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── ToolCard ──────────────────────────────────────────────────────────────

export function ToolCard({ toolName, input, status, logs, result, isExpanded = false, onToggle, sessionId }: ToolCardProps) {
  const [logsOpen, setLogsOpen] = useState(false)
  const [fileViewerPath, setFileViewerPath] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const { label, iconName } = resolveToolMeta(toolName)
  const summary = summarizeInput(toolName, input)
  const isAskUser = toolName === 'ask_user'
  const isInteractive = !(isAskUser && status === 'pending')
  const visibleLogs = logs.slice(0, 50)

  // file_read：从 input 提取路径，拼接完整路径用于显示
  const isFileRead = toolName === 'file_read'
  const filePath = isFileRead && input && typeof input === 'object'
    ? String((input as Record<string, unknown>).path ?? '')
    : ''
  // 文件名（最后一段）
  const fileName = filePath ? filePath.split(/[/\\]/).filter(Boolean).pop() ?? filePath : ''

  // file_edit：提取差异相关字段
  const isFileEdit = toolName === 'file_edit'
  const editInput = isFileEdit && input && typeof input === 'object' ? input as Record<string, unknown> : null
  const editPath = editInput ? String(editInput.path ?? '') : ''
  const editFileName = editPath ? editPath.split(/[/\\]/).filter(Boolean).pop() ?? editPath : ''
  const editOldStr = editInput ? String(editInput.oldStr ?? '') : ''
  const editNewStr = editInput ? String(editInput.newStr ?? '') : ''

  return (
    <>
    <div className="rounded-lg overflow-hidden" style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-subtle)',
    }}>
      {/* ── 标题行 ── */}
      <div
        className={`flex items-center gap-2 px-3 py-2 ${isInteractive && !isFileRead && !isFileEdit ? 'cursor-pointer hover:bg-white/[0.025]' : 'cursor-default'} transition-colors select-none`}
        onClick={isInteractive && !isFileRead && !isFileEdit ? onToggle : undefined}
        role={isInteractive && !isFileRead && !isFileEdit ? 'button' : undefined}
        tabIndex={isInteractive && !isFileRead && !isFileEdit ? 0 : undefined}
        aria-expanded={isInteractive && !isFileRead && !isFileEdit ? isExpanded : undefined}
        onKeyDown={isInteractive && !isFileRead && !isFileEdit ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.() } } : undefined}
      >
        {/* 状态指示（最前面） */}
        <span className="shrink-0 flex items-center">
          <StatusDot status={status} />
        </span>

        {/* 工具图标 */}
        <span style={{ color: 'var(--text-muted)' }} className="shrink-0">
          <Icon name={iconName} size={13} />
        </span>

        {/* 工具名 */}
        <span className="text-[12px] font-medium shrink-0" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>

        {/* 摘要（路径 / 命令 / 查询词） */}
        {isFileRead && fileName ? (
          // file_read：可点击的文件名 badge
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (sessionId && filePath) setFileViewerPath(filePath)
            }}
            className="text-[11px] font-mono truncate flex-1 min-w-0 text-left hover:underline"
            style={{ color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: sessionId ? 'pointer' : 'default' }}
            title={filePath}
          >
            {fileName}
          </button>
        ) : isFileEdit && editFileName ? (
          // file_edit：可点击文件名 + 差异图标按钮
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (sessionId && editPath) setFileViewerPath(editPath)
              }}
              className="text-[11px] font-mono truncate flex-1 min-w-0 text-left hover:underline"
              style={{ color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: sessionId ? 'pointer' : 'default' }}
              title={editPath}
            >
              {editFileName}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDiffOpen(true) }}
              className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70"
              style={{ color: 'var(--accent)', background: 'none', border: 'none' }}
              title="查看差异"
              aria-label="查看差异"
            >
              {/* git-compare：两个圆圈 + 循环箭头 */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="18" r="3"/>
                <circle cx="6" cy="6" r="3"/>
                <path d="M13 6h3a2 2 0 0 1 2 2v7"/>
                <path d="M11 18H8a2 2 0 0 1-2-2V9"/>
                <polyline points="15 9 18 6 21 9"/>
                <polyline points="9 15 6 18 3 15"/>
              </svg>
            </button>
          </>
        ) : summary ? (
          <span className="text-[11px] font-mono truncate flex-1 min-w-0" style={{ color: 'var(--text-muted)' }}>
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}

        {/* 展开箭头（file_read / file_edit 不显示） */}
        {isInteractive && !isFileRead && !isFileEdit && (
          <span style={{ color: 'var(--text-muted)' }} className="shrink-0">
            <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={11} />
          </span>
        )}
      </div>

      {/* ── file_read 错误信息 ── */}
      {isFileRead && status === 'error' && result !== undefined && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <p className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words"
            style={{ color: 'var(--color-error, #f87171)' }}>
            {typeof result === 'object' && result !== null && 'message' in result
              ? String((result as Record<string, unknown>).message)
              : typeof result === 'string'
                ? result
                : JSON.stringify(result)}
          </p>
        </div>
      )}

      {/* ── 展开内容 ── */}
      {isExpanded && isInteractive && !isFileRead && !isFileEdit && (
        <div className="px-3 pt-2.5 pb-3 flex flex-col gap-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>

          {/* bash / powershell：终端一体化展示 */}
          {(toolName === 'bash' || toolName === 'powershell') ? (
            <div className="pt-2.5">
              <BashBlock
                command={String((input as Record<string, unknown>)?.command ?? (input as Record<string, unknown>)?.cmd ?? '')}
                result={result}
                status={status}
              />
            </div>
          ) : (
            <>
              {/* 输入参数（glob / grep / todo 不显示原始 JSON） */}
              {toolName !== 'glob' && toolName !== 'grep' && toolName !== 'todo_write' && toolName !== 'todo_read' && (
              <div className="pt-2.5">
                <p className="text-[10px] uppercase tracking-widest mb-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>输入</p>
                <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words rounded-md px-2.5 py-2 overflow-x-auto"
                  style={{ color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.15)' }}>
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>
              )}

              {/* 执行结果 */}
              {result !== undefined && (
                <div>
                  {toolName !== 'grep' && toolName !== 'glob' && toolName !== 'todo_write' && toolName !== 'todo_read' && (
                    <p className="text-[10px] uppercase tracking-widest mb-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>结果</p>
                  )}
                  {toolName === 'web_search'                    ? <WebSearchResult result={result} /> :
                   toolName === 'web_fetch'                     ? <WebFetchResult result={result} input={input} /> :
                   toolName === 'glob'                          ? <GlobResult result={result} input={input} /> :
                   toolName === 'grep'                          ? <GrepResult result={result} input={input} /> :
                   toolName === 'todo_write' || toolName === 'todo_read' ? <TodoResult input={input} result={result} /> :
                   <GenericResult result={result} />}
                </div>
              )}
            </>
          )}

          {/* 执行日志（可折叠） */}
          {logs.length > 0 && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1 mb-1.5 hover:opacity-80 transition-opacity"
                onClick={() => setLogsOpen(v => !v)}
              >
                <Icon name={logsOpen ? 'chevron-down' : 'chevron-right'} size={10} className="" />
                <span className="text-[10px] uppercase tracking-widest font-medium" style={{ color: 'var(--text-muted)' }}>
                  日志 {logs.length > 50 ? `（前 50 / 共 ${logs.length} 行）` : `（${logs.length} 行）`}
                </span>
              </button>
              {logsOpen && (
                <div className="rounded-md px-2.5 py-2 max-h-36 overflow-y-auto" style={{ background: 'rgba(0,0,0,0.15)' }}>
                  {visibleLogs.map((line, i) => (
                    <div key={i} className="text-[11px] font-mono leading-5" style={{ color: 'var(--text-secondary)' }}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>

    {/* 文件内容弹窗 */}
    {fileViewerPath && sessionId && (
      <FileViewerModal
        sessionId={sessionId}
        filePath={fileViewerPath}
        onClose={() => setFileViewerPath(null)}
      />
    )}

    {/* 差异弹窗 */}
    {diffOpen && isFileEdit && (
      <DiffModal
        filePath={editPath}
        oldStr={editOldStr}
        newStr={editNewStr}
        sessionId={sessionId}
        onClose={() => setDiffOpen(false)}
      />
    )}
  </>
  )
}

export default ToolCard
