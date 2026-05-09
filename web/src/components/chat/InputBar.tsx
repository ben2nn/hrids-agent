import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useSessionStore } from '../../store/sessionStore.js'
import { useMessageStore } from '../../store/messageStore.js'
import { getAvailableModels, uploadFiles, isImageFile, getSkills } from '../../lib/gateway.js'
import type { ModelEntry } from '../../lib/gateway.js'
import type { UploadedFile, Skill } from '../../lib/types.js'

// ─── 暴露的 ref 方法接口 ───────────────────────────────────────────────────

export interface InputBarHandle {
  insertText: (text: string) => void
}

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface InputBarProps {
  sessionId: string
  isBusy: boolean
}

const MAX_ROWS = 8
const LINE_HEIGHT_PX = 20
const MIN_ROWS = 3

// ─── 权限模式配置 ──────────────────────────────────────────────────────────

type PermMode = 'ask' | 'plan' | 'craft'

const PERM_MODES: Array<{ value: PermMode; label: string; desc: string; icon: string }> = [
  { value: 'ask',   label: 'Ask',   desc: '每次写操作都询问确认', icon: '❓' },
  { value: 'plan',  label: 'Plan',  desc: '规划模式没有写权限',   icon: '📋' },
  { value: 'craft', label: 'Craft', desc: '自主执行，无需确认',   icon: '⚡' },
]

// ─── CraftDropdown ─────────────────────────────────────────────────────────

interface CraftDropdownProps {
  currentMode: PermMode
  onSelect: (mode: PermMode) => void
}

function CraftDropdown({ currentMode, onSelect }: CraftDropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = PERM_MODES.find(m => m.value === currentMode)!

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={[
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 border',
          open
            ? 'bg-[var(--bg-elevated)] border-[var(--border-focus)] text-[var(--text-primary)]'
            : 'bg-[var(--bg-tertiary)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-focus)]',
        ].join(' ')}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        <span className="font-mono">{current.label}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* 下拉菜单 */}
      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-52 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] overflow-hidden z-50 animate-fade-in">
          <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              权限模式
            </span>
          </div>
          {PERM_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => { onSelect(mode.value); setOpen(false) }}
              className={[
                'flex items-center gap-3 w-full px-3 py-2.5 text-left transition-colors duration-100',
                currentMode === mode.value
                  ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              <span className="text-base w-5 text-center shrink-0">{mode.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold leading-tight">{mode.label}</div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{mode.desc}</div>
              </div>
              {currentMode === mode.value && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-[var(--accent)] shrink-0">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── AutoDropdown（模型选择） ──────────────────────────────────────────────

interface AutoDropdownProps {
  currentModel?: string
  selectedModel: string | null  // null = Auto
  onSelect: (model: string | null) => void
}

function AutoDropdown({ currentModel, selectedModel, onSelect }: AutoDropdownProps) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // 打开时懒加载模型列表
  useEffect(() => {
    if (!open || loaded) return
    getAvailableModels()
      .then(res => { setModels(res.models); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [open, loaded])

  // 显示名：selectedModel 不为 null 时显示选中的模型名，否则显示 Auto
  const displayLabel = selectedModel
    ? (selectedModel.length > 16 ? selectedModel.slice(0, 14) + '…' : selectedModel)
    : 'Auto'

  // 高亮逻辑：selectedModel 为 null 表示用户主动选了 Auto，高亮 Auto 行
  // selectedModel 为具体字符串，高亮对应模型行
  const isAutoSelected = selectedModel === null
  const activeModelHighlight = selectedModel ?? null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title={currentModel ? `当前会话：${currentModel}` : undefined}
        className={[
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 border',
          open
            ? 'bg-[var(--bg-elevated)] border-[var(--border-focus)] text-[var(--text-primary)]'
            : selectedModel
              ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[var(--accent-light,#60a5fa)]'
              : 'bg-[var(--bg-tertiary)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-focus)]',
        ].join(' ')}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        <span className="font-mono">{displayLabel}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-64 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] overflow-hidden z-50 animate-fade-in">
          <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              下次会话使用的模型
            </span>
          </div>

          <div className="max-h-52 overflow-y-auto">
            {/* Auto 选项 */}
            <button
              type="button"
              onClick={() => { onSelect(null); setOpen(false) }}
              className={[
                'flex items-center gap-2 w-full px-3 py-2.5 text-left transition-colors duration-100',
                isAutoSelected
                  ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono font-semibold">Auto</div>
                <div className="text-[10px] text-[var(--text-muted)]">自动选择最优模型</div>
              </div>
              {isAutoSelected && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-[var(--accent)] shrink-0">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>

            {/* 分割线 */}
            {models.length > 0 && <div className="border-t border-[var(--border-subtle)] mx-3" />}

            {!loaded ? (
              <div className="px-3 py-4 text-xs text-[var(--text-muted)] text-center">加载中...</div>
            ) : (
              models.map((m) => (
                <button
                  key={`${m.provider}-${m.model}`}
                  type="button"
                  onClick={() => { onSelect(m.model); setOpen(false) }}
                  className={[
                    'flex items-center gap-2 w-full px-3 py-2.5 text-left transition-colors duration-100',
                    m.model === activeModelHighlight
                      ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
                  ].join(' ')}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono truncate">{m.model}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">{m.provider}</div>
                  </div>
                  {m.isDefault && (
                    <span className="text-[10px] text-[var(--accent)] shrink-0">默认</span>
                  )}
                  {m.model === activeModelHighlight && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-[var(--accent)] shrink-0">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>

          <div className="px-3 py-2 border-t border-[var(--border-subtle)]">
            <p className="text-[10px] text-[var(--text-muted)]">
              选择后下次新建会话时生效
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── SkillsButton ──────────────────────────────────────────────────────────

interface SkillsButtonProps {
  onSelect: (skill: Skill) => void
}

function SkillsButton({ onSelect }: SkillsButtonProps) {
  const [open, setOpen] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // 打开时懒加载技能列表，并聚焦搜索框
  useEffect(() => {
    if (!open) { setQuery(''); return }
    if (!loaded) {
      getSkills()
        .then(data => { setSkills(data); setLoaded(true) })
        .catch(() => setLoaded(true))
    }
    // 延迟聚焦，等弹框渲染完成
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, loaded])

  // 过滤：排除内置技能，按名称或描述搜索
  const userSkills = skills.filter(s => s.source !== 'builtin')
  const filtered = query.trim()
    ? userSkills.filter(s =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        (s.description ?? '').toLowerCase().includes(query.toLowerCase()),
      )
    : userSkills

  function handleSelect(skill: Skill) {
    onSelect(skill)
    setOpen(false)
    setQuery('')
  }

  // 根据名称生成稳定背景色（复用 SkillsPage 的逻辑）
  function getIconBg(name: string): string {
    const colors = [
      'bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500',
      'bg-pink-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
    ]
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff
    return colors[Math.abs(hash) % colors.length]
  }

  function getInitials(name: string): string {
    const words = name.trim().split(/[\s_-]+/)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={[
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 border',
          open
            ? 'bg-[var(--bg-elevated)] border-[var(--border-focus)] text-[var(--text-primary)]'
            : 'bg-[var(--bg-tertiary)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-focus)]',
        ].join(' ')}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
        <span>Skills</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-72 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] overflow-hidden z-50 animate-fade-in">
          {/* 标题 */}
          <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              选择技能
            </span>
          </div>

          {/* 搜索框 */}
          <div className="px-2 py-2 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border)]">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-[var(--text-muted)] shrink-0">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索技能..."
                className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* 技能列表 */}
          <div className="max-h-60 overflow-y-auto">
            {!loaded ? (
              <div className="px-3 py-6 text-xs text-[var(--text-muted)] text-center">加载中...</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-6 text-xs text-[var(--text-muted)] text-center">
                {query ? `未找到"${query}"相关技能` : '暂无可用技能'}
              </div>
            ) : (
              filtered.map(skill => (
                <button
                  key={skill.name}
                  type="button"
                  onClick={() => handleSelect(skill)}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left transition-colors duration-100 hover:bg-[var(--bg-tertiary)]"
                >
                  {/* 图标 */}
                  <div className={`w-7 h-7 rounded-lg ${getIconBg(skill.name)} flex items-center justify-center shrink-0`}>
                    <span className="text-[10px] font-bold text-white">{getInitials(skill.name)}</span>
                  </div>
                  {/* 文字 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-[var(--text-primary)] truncate">{skill.name}</span>
                      <span className={[
                        'shrink-0 text-[9px] px-1 py-0.5 rounded font-medium',
                        skill.source === 'builtin'
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-green-500/20 text-green-400',
                      ].join(' ')}>
                        {skill.source === 'builtin' ? '内置' : '用户'}
                      </span>
                    </div>
                    {skill.description && (
                      <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">{skill.description}</div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* 底部提示 */}
          <div className="px-3 py-2 border-t border-[var(--border-subtle)]">
            <p className="text-[10px] text-[var(--text-muted)]">点击技能将其引用到输入框</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── InputBar 主组件 ───────────────────────────────────────────────────────

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/** 格式化文件大小显示 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 检测用户消息是否包含写文件/写操作意图
function hasWriteIntent(message: string): boolean {
  const WRITE_PATTERNS = [
    // 写/创建/新建文件
    /写(一个|个|一份|份)?(文件|代码|脚本|配置|文档)/,
    /创建(一个|个|一份|份)?(文件|目录|文件夹|脚本|配置)/,
    /新建(一个|个|一份|份)?(文件|目录|文件夹)/,
    /生成(一个|个|一份|份)?(文件|代码|脚本|配置|文档)/,
    // 修改/编辑/更新文件
    /修改(一下|下)?(文件|代码|配置|内容)/,
    /编辑(一下|下)?(文件|代码|配置)/,
    /更新(一下|下)?(文件|代码|配置|内容)/,
    /改(一下|下|改)?(文件|代码|配置|这个|那个)/,
    // 保存/写入
    /保存(到|为|成)?(文件)?/,
    /写入(文件|磁盘|到)?/,
    // 删除文件
    /删除(文件|目录|文件夹|这个|那个)/,
    /移除(文件|目录|这个|那个)/,
    // 执行/运行命令（写操作类）
    /执行(命令|脚本|这个|以下)/,
    /运行(命令|脚本|这个|以下)/,
    /安装(依赖|包|插件|模块)/,
    // 帮我 + 动作
    /帮(我|忙)(写|创建|新建|生成|修改|编辑|更新|删除|执行|运行|安装)/,
    // 英文意图
    /\b(write|create|make|generate|edit|modify|update|delete|remove|save|install|run|execute)\b.*\b(file|files|script|config|code|dir|folder)\b/i,
    /\b(create|write|make)\s+(a|an|the)?\s*(new\s+)?(file|script|config|folder|directory)\b/i,
  ]
  return WRITE_PATTERNS.some(p => p.test(message))
}

// ─── InputBar 主组件 ───────────────────────────────────────────────────────

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(
  function InputBar({ sessionId, isBusy }, ref) {
    const [text, setText] = useState('')
    const [planModeWarning, setPlanModeWarning] = useState(false)
    const [hasSent, setHasSent] = useState(false)  // 本轮是否已发送过消息
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // ── 附件状态 ──────────────────────────────────────────────────────────
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [pendingFiles, setPendingFiles] = useState<File[]>([])
    const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
    const [isUploading, setIsUploading] = useState(false)
    const [uploadError, setUploadError] = useState<string | null>(null)
    // 图片本地预览 URL（objectURL），key 为文件名
    const [imagePreviews, setImagePreviews] = useState<Map<string, string>>(new Map())

    const sessions = useSessionStore((s) => s.sessions)
    const sendMessage = useSessionStore((s) => s.sendMessage)
    const sendAbort = useSessionStore((s) => s.sendAbort)
    const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
    const pendingModel = useSessionStore((s) => s.pendingModel)
    const setPendingModel = useSessionStore((s) => s.setPendingModel)
    const appendUserMessage = useMessageStore((s) => s.appendUserMessage)
    const pendingContinuation = useMessageStore((s) => s.pendingContinuation)
    const clearContinuation = useMessageStore((s) => s.clearContinuation)

    const hasContinuation = pendingContinuation.has(sessionId)

    // 当前会话的权限模式（默认 ask）
    const activeSession = sessions.find(s => s.id === sessionId)
    const permissionMode: PermMode = (activeSession?.permissionMode as PermMode) ?? 'ask'

    // isBusy 结束时重置 hasSent，为下一轮发送做准备
    useEffect(() => {
      if (!isBusy) setHasSent(false)
    }, [isBusy])

    // sessionId 切换时重置 hasSent 和附件状态（保活场景下组件不重建，需手动重置）
    useEffect(() => {
      setHasSent(false)
      setPendingFiles([])
      setUploadedFiles([])
      setIsUploading(false)
      setUploadError(null)
      setImagePreviews(prev => {
        prev.forEach(url => URL.revokeObjectURL(url))
        return new Map()
      })
    }, [sessionId])
    // 自动扩展 textarea 高度，最小保持 MIN_ROWS 行
    useEffect(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      const minHeight = MIN_ROWS * LINE_HEIGHT_PX + 24
      const maxHeight = MAX_ROWS * LINE_HEIGHT_PX + 24
      el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`
    }, [text])

    // 暴露 insertText 方法
    useImperativeHandle(ref, () => ({
      insertText(insertStr: string) {
        const el = textareaRef.current
        if (!el) { setText(prev => prev + insertStr); return }
        const start = el.selectionStart ?? el.value.length
        const end = el.selectionEnd ?? el.value.length
        const newValue = el.value.slice(0, start) + insertStr + el.value.slice(end)
        setText(newValue)
        requestAnimationFrame(() => {
          el.focus()
          const cursor = start + insertStr.length
          el.setSelectionRange(cursor, cursor)
        })
      },
    }), [])

    const handleSend = useCallback(() => {
      const trimmed = text.trim()
      // 有已上传文件时即使文本为空也允许发送
      if ((!trimmed && uploadedFiles.length === 0) || isBusy) return

      // plan 模式下检测写文件/写操作意图，提前提示用户
      if (permissionMode === 'plan' && hasWriteIntent(trimmed)) {
        setPlanModeWarning(true)
        return
      }

      setPlanModeWarning(false)

      // 若有已上传文件，在消息末尾附加 @文件名 引用
      let content = trimmed
      if (uploadedFiles.length > 0) {
        const fileRefs = uploadedFiles.map(f => `@${f.name}`).join(' ')
        content = trimmed ? `${trimmed} ${fileRefs}` : fileRefs
      }

      // 收集图片文件名，用于消息气泡中显示预览
      const imageNames = uploadedFiles.filter(f => isImageFile(f.name)).map(f => f.name)

      // 气泡显示用的文本：去掉 @图片文件名（图片通过 images 字段单独渲染，避免重复）
      const imageNameSet = new Set(imageNames)
      const displayContent = uploadedFiles.length > 0
        ? (trimmed || uploadedFiles.filter(f => !imageNameSet.has(f.name)).map(f => `@${f.name}`).join(' ')).trim()
        : trimmed

      appendUserMessage(sessionId, displayContent || content, imageNames.length > 0 ? imageNames : undefined)
      sendMessage(sessionId, content)
      setText('')
      setHasSent(true)
      setUploadedFiles([])
      setPendingFiles([])
      setUploadError(null)
      // 清理图片预览 objectURL
      setImagePreviews(prev => {
        prev.forEach(url => URL.revokeObjectURL(url))
        return new Map()
      })
    }, [text, isBusy, permissionMode, sessionId, appendUserMessage, sendMessage, uploadedFiles])

    // ── 附件处理 ──────────────────────────────────────────────────────────

    const handleAttachClick = useCallback(() => {
      fileInputRef.current?.click()
    }, [])

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length === 0 || !sessionId) return

      // 重置 input，允许重复选择同一文件
      e.target.value = ''

      // 为图片文件生成本地预览 objectURL
      const newPreviews = new Map<string, string>()
      for (const file of files) {
        if (isImageFile(file.name)) {
          newPreviews.set(file.name, URL.createObjectURL(file))
        }
      }
      if (newPreviews.size > 0) {
        setImagePreviews(prev => new Map([...prev, ...newPreviews]))
      }

      setPendingFiles(prev => [...prev, ...files])
      setUploadError(null)
      setIsUploading(true)

      try {
        const result = await uploadFiles(sessionId, files)
        // 后端返回的 name 带 .cache/ 前缀（如 .cache/photo.jpg），提取原始文件名用于匹配
        const getBaseName = (name: string) => name.split('/').pop() ?? name
        const enriched = result.files.map(f => ({ ...f, isImage: isImageFile(getBaseName(f.name)) }))
        setUploadedFiles(prev => [...prev, ...enriched])
        // 用原始文件名匹配 pendingFiles（后端返回的 name 有 .cache/ 前缀，pendingFiles 用原始名）
        setPendingFiles(prev => {
          const uploadedBaseNames = new Set(result.files.map(f => getBaseName(f.name)))
          return prev.filter(f => !uploadedBaseNames.has(f.name))
        })
      } catch (err) {
        setUploadError(`上传失败: ${String(err)}`)
        setPendingFiles([])
        // 清理预览 URL
        newPreviews.forEach(url => URL.revokeObjectURL(url))
        setImagePreviews(prev => {
          const next = new Map(prev)
          newPreviews.forEach((_, name) => next.delete(name))
          return next
        })
      } finally {
        setIsUploading(false)
      }
    }, [sessionId])

    const handleRemoveUploadedFile = useCallback((name: string) => {
      setUploadedFiles(prev => prev.filter(f => f.name !== name))
      // 清理图片预览 objectURL
      setImagePreviews(prev => {
        const url = prev.get(name)
        if (url) URL.revokeObjectURL(url)
        const next = new Map(prev)
        next.delete(name)
        return next
      })
    }, [])
    const handleAbort = useCallback(() => {
      sendAbort(sessionId)
    }, [sessionId, sendAbort])

    // 用户确认继续执行：仅在 plan 模式下切换到 ask，其他模式直接发消息
    const handleContinueExecution = useCallback(() => {
      clearContinuation(sessionId)
      if (permissionMode === 'plan') {
        setPermissionMode(sessionId, 'ask')
      }
      appendUserMessage(sessionId, '请按照上述计划执行')
      sendMessage(sessionId, '请按照上述计划执行')
    }, [sessionId, permissionMode, clearContinuation, setPermissionMode, appendUserMessage, sendMessage])

    // plan 模式下用户放弃继续执行
    const handleDismissContinuation = useCallback(() => {
      clearContinuation(sessionId)
    }, [sessionId, clearContinuation])

    // plan 模式写意图警告：切换到 ask 模式后发送原始消息
    const handleSendInAskMode = useCallback(() => {
      const trimmed = text.trim()
      setPlanModeWarning(false)
      setPermissionMode(sessionId, 'ask')

      let content = trimmed
      if (uploadedFiles.length > 0) {
        const fileRefs = uploadedFiles.map(f => `@${f.name}`).join(' ')
        content = trimmed ? `${trimmed} ${fileRefs}` : fileRefs
      }

      const imageNames = uploadedFiles.filter(f => isImageFile(f.name)).map(f => f.name)

      // 气泡显示用的文本：去掉 @图片文件名
      const imageNameSet2 = new Set(imageNames)
      const displayContent2 = uploadedFiles.length > 0
        ? (trimmed || uploadedFiles.filter(f => !imageNameSet2.has(f.name)).map(f => `@${f.name}`).join(' ')).trim()
        : trimmed

      appendUserMessage(sessionId, displayContent2 || content, imageNames.length > 0 ? imageNames : undefined)
      sendMessage(sessionId, content)
      setText('')
      setUploadedFiles([])
      setPendingFiles([])
      setUploadError(null)
      setImagePreviews(prev => {
        prev.forEach(url => URL.revokeObjectURL(url))
        return new Map()
      })
    }, [text, sessionId, setPermissionMode, appendUserMessage, sendMessage, uploadedFiles])

    const handleDismissPlanWarning = useCallback(() => {
      setPlanModeWarning(false)
    }, [])

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    }, [handleSend])

    const canSend = (text.trim().length > 0 || uploadedFiles.length > 0) && !isBusy

    return (
      <div className="bg-[var(--bg-primary)] border-t border-[var(--border-subtle)]">

        {/* 隐藏的文件选择 input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.json,.csv"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          aria-hidden="true"
        />

        {/* ── 提示条区域（plan / warning / continuation / ask_user） ── */}
        <div className="px-4 pt-2 flex flex-col gap-1.5">

          {/* plan 模式写意图警告 */}
          {planModeWarning && permissionMode === 'plan' && (
            <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 animate-fade-in">
              <div className="flex items-start gap-2">
                <span className="text-sm shrink-0">⚠️</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed mb-2">
                    消息包含写文件意图，规划模式下写操作会被禁止。是否切换到执行模式后发送？
                  </p>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={handleSendInAskMode}
                      className="bg-amber-500 hover:bg-amber-400 text-white px-2.5 py-1 rounded-md text-xs font-semibold transition-all">
                      切换并发送
                    </button>
                    <button type="button" onClick={handleDismissPlanWarning}
                      className="bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2.5 py-1 rounded-md text-xs transition-all">
                      继续规划
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* continuation_needed */}
          {hasContinuation && !isBusy && (
            <div className="bg-[var(--accent-subtle)] border border-[var(--accent-border)] rounded-lg px-3 py-2 animate-fade-in">
              <p className="text-xs text-[var(--text-secondary)] mb-2">
                {permissionMode === 'plan'
                  ? 'Agent 已完成规划，是否切换到执行模式并按计划执行？'
                  : 'Agent 想继续执行后续步骤，是否继续？'}
              </p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleContinueExecution}
                  className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-2.5 py-1 rounded-md text-xs font-semibold transition-all">
                  {permissionMode === 'plan' ? '批准并执行' : '继续执行'}
                </button>
                <button type="button" onClick={handleDismissContinuation}
                  className="bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2.5 py-1 rounded-md text-xs transition-all">
                  {permissionMode === 'plan' ? '继续规划' : '忽略'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── 主输入卡片：textarea + 工具栏合为一体 ── */}
        <div className="px-4 py-3">
          <div className="input-container">

            {/* 执行中提示行（发送后才显示） */}
            {isBusy && hasSent && (
              <div className="flex items-center gap-2 px-3.5 pt-2.5 text-xs text-[var(--text-secondary)]">
                <span className="relative flex shrink-0">
                  <span className="absolute w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping opacity-75" />
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                </span>
                <span>运行中...</span>
              </div>
            )}

            {/* 附件预览区 */}
            {(pendingFiles.length > 0 || uploadedFiles.length > 0 || uploadError) && (
              <div className="px-3.5 pt-2.5 flex flex-col gap-1.5">
                {/* 上传错误提示 */}
                {uploadError && (
                  <div className="flex items-center gap-2 text-xs text-[var(--error)] bg-[var(--error-subtle)] rounded-lg px-2.5 py-1.5">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span className="flex-1 truncate">{uploadError}</span>
                    <button type="button" onClick={() => setUploadError(null)} className="shrink-0 hover:opacity-70">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}

                {/* 上传中的文件 */}
                {pendingFiles.map((file) => (
                  <div key={file.name} className="flex items-center gap-2 text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded-lg px-2.5 py-1.5">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 animate-spin text-[var(--accent)]">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    <span className="flex-1 truncate">{file.name}</span>
                    <span className="shrink-0 text-[var(--text-muted)]">上传中...</span>
                  </div>
                ))}

                {/* 已上传的文件：图片显示缩略图，普通文件显示文件名 */}
                {(() => {
                  const imageFiles = uploadedFiles.filter(f => f.isImage)
                  const otherFiles = uploadedFiles.filter(f => !f.isImage)
                  return (
                    <>
                      {/* 图片缩略图网格 */}
                      {imageFiles.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {imageFiles.map((file) => {
                            const baseName = file.name.split('/').pop() ?? file.name
                            const previewUrl = imagePreviews.get(baseName)
                            return (
                              <div key={file.name} className="relative group">
                                <div className="w-16 h-16 rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-tertiary)]">
                                  {previewUrl ? (
                                    <img
                                      src={previewUrl}
                                      alt={file.name}
                                      className="w-full h-full object-cover"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-[var(--text-muted)]">
                                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                                        <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                                      </svg>
                                    </div>
                                  )}
                                </div>
                                {/* 悬停时显示文件名和删除按钮 */}
                                <div className="absolute inset-0 rounded-lg bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveUploadedFile(file.name)}
                                    className="text-white hover:text-red-300 transition-colors"
                                    title={`移除 ${file.name}`}
                                    aria-label={`移除 ${file.name}`}
                                  >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                  </button>
                                </div>
                                {/* 图片名称 tooltip */}
                                <div className="absolute -bottom-5 left-0 right-0 text-center text-[9px] text-[var(--text-muted)] truncate px-0.5" title={file.name}>
                                  {file.name.length > 10 ? file.name.slice(0, 8) + '…' : file.name}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {/* 图片缩略图下方留出空间 */}
                      {imageFiles.length > 0 && <div className="h-4" />}

                      {/* 普通文件列表 */}
                      {otherFiles.map((file) => (
                        <div key={file.name} className="flex items-center gap-2 text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded-lg px-2.5 py-1.5">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0 text-[var(--success)]">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          <span className="flex-1 truncate" title={file.path}>{file.name}</span>
                          <span className="shrink-0 text-[var(--text-muted)]">{formatFileSize(file.size)}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveUploadedFile(file.name)}
                            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
                            title="移除"
                            aria-label={`移除 ${file.name}`}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </>
                  )
                })()}
              </div>
            )}

            {/* 文本输入区 */}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => { setText(e.target.value); setPlanModeWarning(false) }}
              onKeyDown={handleKeyDown}
              disabled={isBusy}
              rows={MIN_ROWS}
              placeholder={
                isBusy ? '运行中，请等待完成...' : '输入任务描述...'
              }
              className="w-full bg-transparent text-[var(--text-primary)] text-sm resize-none focus:outline-none placeholder-[var(--text-muted)] leading-5 disabled:opacity-40 disabled:cursor-not-allowed px-3.5 pt-2.5 pb-2"
              aria-label="输入消息"
            />

            {/* 工具栏：与输入框同在卡片内，用细线分隔 */}
            <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-[var(--border-subtle)]">

              {/* 左侧：Craft / 模型 / Skills */}
              <div className="flex items-center gap-1">
                <CraftDropdown
                  currentMode={permissionMode}
                  onSelect={(mode) => setPermissionMode(sessionId, mode)}
                />
                <AutoDropdown
                  currentModel={activeSession?.model}
                  selectedModel={pendingModel}
                  onSelect={setPendingModel}
                />
                <SkillsButton
                  onSelect={(skill) => {
                    const el = textareaRef.current
                    const insertStr = `@${skill.name} `
                    if (!el) { setText(prev => prev + insertStr); return }
                    const start = el.selectionStart ?? el.value.length
                    const end = el.selectionEnd ?? el.value.length
                    const newValue = el.value.slice(0, start) + insertStr + el.value.slice(end)
                    setText(newValue)
                    requestAnimationFrame(() => {
                      el.focus()
                      const cursor = start + insertStr.length
                      el.setSelectionRange(cursor, cursor)
                    })
                  }}
                />
              </div>

              {/* 右侧：附件 + 发送/中止 */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleAttachClick}
                  disabled={isUploading}
                  className={[
                    'w-7 h-7 flex items-center justify-center rounded-lg transition-all',
                    isUploading
                      ? 'text-[var(--accent)] cursor-wait'
                      : uploadedFiles.length > 0
                        ? 'text-[var(--accent)] bg-[var(--accent-subtle)] hover:bg-[var(--accent-subtle)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]',
                  ].join(' ')}
                  title={isUploading ? '上传中...' : '添加附件（上传到工作目录）'}
                  aria-label="添加附件"
                >
                  {isUploading ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-spin">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  )}
                </button>
                {/* 已上传文件数量徽标 */}
                {uploadedFiles.length > 0 && !isUploading && (
                  <span className="text-[10px] font-semibold text-[var(--accent)] -ml-1 mr-0.5 leading-none">
                    {uploadedFiles.length}
                  </span>
                )}

                {isBusy ? (
                  <button type="button" onClick={handleAbort}
                    className="flex items-center gap-1.5 bg-[var(--error-subtle)] hover:bg-[var(--error)]/20 border border-[var(--error)]/30 text-[var(--error)] px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                    aria-label="中止任务">
                    <span className="w-2 h-2 rounded-sm bg-[var(--error)] inline-block" />
                    中止
                  </button>
                ) : (
                  <button type="button"
                    onClick={handleSend}
                    disabled={!canSend}
                    className="flex items-center justify-center w-8 h-8 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-muted)] text-white rounded-lg transition-all disabled:cursor-not-allowed shadow-sm"
                    aria-label="发送消息">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>
    )
  },
)

export default InputBar
