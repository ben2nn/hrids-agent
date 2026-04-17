import { useEffect, useRef, useState } from 'react'
import { getSkills, searchMarketSkills, toggleSkillEnabled, installMarketSkill, uninstallMarketSkill } from '../../lib/gateway.js'
import { MarkdownRenderer } from '../../lib/markdown.js'
import type { Skill } from '../../lib/types.js'
import type { MarketSkill } from '../../lib/gateway.js'

// ─── 顶层 Tab ──────────────────────────────────────────────────────────────

type MainTab = 'installed' | 'market' | 'mcp'

const MAIN_TABS: Array<{ value: MainTab; label: string }> = [
  { value: 'installed', label: '已安装' },
  { value: 'market',    label: '技能市场' },
  { value: 'mcp',       label: 'MCP 服务' },
]

// ─── 已安装子 Tab ──────────────────────────────────────────────────────────

type InstalledTab = 'builtin' | 'user'

const INSTALLED_TABS: Array<{ value: InstalledTab; label: string; icon: string; emptyDir: string }> = [
  { value: 'builtin', label: '内置技能', icon: '⚡', emptyDir: '' },
  { value: 'user',    label: '用户技能', icon: '👤', emptyDir: '~/.hrids-agent/skills/' },
]

// ─── 来源标签配置 ──────────────────────────────────────────────────────────

const SOURCE_BADGE: Record<InstalledTab, { text: string; className: string }> = {
  builtin: { text: '内置', className: 'bg-blue-500/20 text-blue-400 border border-blue-500/30' },
  user:    { text: '用户', className: 'bg-green-500/20 text-green-400 border border-green-500/30' },
}

const INSTALLED_BADGE = { text: '已安装', className: 'bg-purple-500/20 text-purple-400 border border-purple-500/30' }
const CUSTOM_BADGE    = { text: '自建',   className: 'bg-green-500/20 text-green-400 border border-green-500/30' }

// ─── 骨架屏 ────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] p-3 animate-pulse">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-9 h-9 rounded-lg bg-[var(--bg-tertiary)] shrink-0" />
        <div className="h-3 flex-1 bg-[var(--bg-tertiary)] rounded" />
      </div>
      <div className="space-y-1.5">
        <div className="h-2.5 w-full bg-[var(--bg-tertiary)] rounded" />
        <div className="h-2.5 w-3/4 bg-[var(--bg-tertiary)] rounded" />
      </div>
    </div>
  )
}

// ─── 已安装技能卡片 ────────────────────────────────────────────────────────

// 根据名称生成稳定背景色
function getSkillIconBg(name: string): string {
  const colors = [
    'bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500',
    'bg-pink-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff
  return colors[Math.abs(hash) % colors.length]
}

function getSkillInitials(name: string): string {
  const words = name.trim().split(/[\s_\-]+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

interface SkillCardProps {
  skill: Skill
  expanded: boolean
  onToggle: () => void
  onToggleEnabled?: (enabled: boolean) => void
  onUninstall?: () => void
}

function SkillCard({ skill, expanded, onToggle, onToggleEnabled, onUninstall }: SkillCardProps) {
  const source = (skill.source === 'builtin' ? 'builtin' : 'user') as InstalledTab
  const badge = source === 'builtin'
    ? SOURCE_BADGE.builtin
    : (skill.installed ? INSTALLED_BADGE : CUSTOM_BADGE)
  const iconBg = getSkillIconBg(skill.name)
  const initials = getSkillInitials(skill.name)
  const isUser = skill.source === 'user'
  const isEnabled = skill.enabled !== false
  const [uninstalling, setUninstalling] = useState(false)

  async function handleUninstall(e: React.MouseEvent) {
    e.stopPropagation()
    setUninstalling(true)
    try {
      await uninstallMarketSkill(skill.name)
      onUninstall?.()
    } catch { /* 忽略，父组件刷新后会更新 */ } finally {
      setUninstalling(false)
    }
  }

  return (
    <div
      className={`relative bg-[var(--bg-secondary)] rounded-xl border p-3 cursor-pointer hover:shadow-sm transition-all duration-150 group flex flex-col gap-2 ${
        isUser && !isEnabled
          ? 'border-[var(--border)] opacity-50'
          : 'border-[var(--border)] hover:border-[var(--accent)]'
      }`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() }
      }}
      aria-expanded={expanded}
    >
      {/* 右上角来源标签 */}
      <span className={`absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded-md font-medium ${badge.className}`}>
        {badge.text}
      </span>

      {/* 图标 + 名称 */}
      <div className="flex items-center gap-2 pr-10">
        <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center shrink-0 text-white text-xs font-bold shadow-sm`}>
          {initials}
        </div>
        <span className="text-xs font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors leading-tight">
          {skill.name}
        </span>
      </div>

      {/* 描述 */}
      {skill.description && (
        <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2 leading-relaxed">
          {skill.description}
        </p>
      )}

      {/* 用户技能底部：卸载按钮（安装技能）+ 启用/禁用滑块 */}
      {isUser && (onToggleEnabled || (skill.installed && onUninstall)) && (
        <div
          className="flex items-center justify-between mt-auto pt-1.5 border-t border-[var(--border)]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 左侧：卸载按钮（仅安装技能显示） */}
          {skill.installed && onUninstall ? (
            <button
              type="button"
              onClick={handleUninstall}
              disabled={uninstalling}
              className="text-[10px] px-2 py-0.5 rounded-md text-red-400 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uninstalling ? '卸载中...' : '卸载'}
            </button>
          ) : <span />}

          {/* 右侧：启用/禁用滑块 */}
          {onToggleEnabled && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-[var(--text-muted)]">{isEnabled ? '已启用' : '已禁用'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={isEnabled}
                onClick={() => onToggleEnabled(!isEnabled)}
                className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                  isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'
                }`}
              >
                <span className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow-sm transform transition-transform duration-200 ${isEnabled ? 'translate-x-3' : 'translate-x-0'}`} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* 展开内容 */}
      {expanded && skill.prompt && (
        <div className="mt-1 pt-2 border-t border-[var(--border)]" onClick={(e) => e.stopPropagation()}>
          <div className="text-[11px] text-[var(--text-secondary)] leading-relaxed max-h-40 overflow-y-auto">
            <MarkdownRenderer content={skill.prompt} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 已安装 Tab 内容 ───────────────────────────────────────────────────────

interface InstalledPanelProps {
  skills: Skill[]
  loading: boolean
  error: string | null
}

function InstalledPanel({ skills, loading, error }: InstalledPanelProps) {
  const [activeTab, setActiveTab] = useState<InstalledTab>('builtin')
  const [expandedIds] = useState<Set<string>>(new Set())
  const [skillList, setSkillList] = useState<Skill[]>(skills)
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)

  // skills prop 变化时同步
  useEffect(() => { setSkillList(skills) }, [skills])

  async function handleToggleEnabled(skillName: string, enabled: boolean) {
    // 乐观更新
    setSkillList(prev => prev.map(s => s.name === skillName ? { ...s, enabled } : s))
    try {
      await toggleSkillEnabled(skillName, enabled)
    } catch {
      // 失败回滚
      setSkillList(prev => prev.map(s => s.name === skillName ? { ...s, enabled: !enabled } : s))
    }
  }

  async function handleUninstallSkill() {
    // 卸载后重新拉取列表
    try {
      const data = await getSkills()
      setSkillList(data)
    } catch { /* 忽略 */ }
  }

  function handleCardClick(skill: Skill) {
    setSelectedSkill(skill)
  }

  function handleCloseDetail() {
    setSelectedSkill(null)
  }

  const counts: Record<InstalledTab, number> = {
    builtin: skillList.filter(s => s.source === 'builtin').length,
    user:    skillList.filter(s => s.source === 'user').length,
  }

  const filtered = skillList.filter(s => s.source === activeTab)
  const tabInfo = INSTALLED_TABS.find(t => t.value === activeTab)!

  return (
    <>
      {/* 技能详情弹层 */}
      {selectedSkill && (
        <InstalledSkillDetailModal
          skill={selectedSkill}
          onClose={handleCloseDetail}
          onToggleEnabled={selectedSkill.source === 'user' ? (en) => {
            handleToggleEnabled(selectedSkill.name, en)
            setSelectedSkill(prev => prev ? { ...prev, enabled: en } : null)
          } : undefined}
          onUninstall={selectedSkill.installed ? async () => {
            handleCloseDetail()
            await handleUninstallSkill()
          } : undefined}
        />
      )}

    <div className="flex flex-col gap-4">
      {/* 子 Tab 切换 */}
      {!loading && !error && (
        <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-xl border border-[var(--border)]">
          {INSTALLED_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setActiveTab(tab.value)}
              className={[
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150',
                activeTab === tab.value
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
              {counts[tab.value] > 0 && (
                <span className="text-[10px] bg-[var(--accent)] text-white rounded-full px-1.5 py-0.5 leading-none font-semibold">
                  {counts[tab.value]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 加载中 */}
      {loading && (
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: 10 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {/* 加载失败 */}
      {!loading && error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          <span className="font-medium">加载失败：</span>{error}
        </div>
      )}

      {/* 空列表 */}
      {!loading && !error && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--text-secondary)]">
          <span className="text-4xl mb-3">{tabInfo.icon}</span>
          <p className="text-sm font-medium mb-1">暂无{tabInfo.label}</p>
          {tabInfo.emptyDir && (
            <p className="text-xs text-[var(--text-muted)] text-center max-w-[220px] leading-relaxed">
              在 <code className="bg-[var(--bg-tertiary)] px-1 rounded">{tabInfo.emptyDir}</code> 目录下添加 .md 文件
            </p>
          )}
        </div>
      )}

      {/* 技能卡片网格 - 每排5个 */}
      {!loading && !error && filtered.length > 0 && (
        activeTab === 'user' ? (
          // 用户技能：分组显示安装技能和自建技能
          <div className="flex flex-col gap-5">
            {/* 安装技能 */}
            {filtered.filter(s => s.installed).length > 0 && (
              <div>
                <p className="text-xs font-medium text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                  安装技能
                  <span className="text-[10px]">({filtered.filter(s => s.installed).length})</span>
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {filtered.filter(s => s.installed).map((skill) => (
                    <SkillCard key={skill.name} skill={skill} expanded={expandedIds.has(skill.name)} onToggle={() => handleCardClick(skill)} onToggleEnabled={(en) => handleToggleEnabled(skill.name, en)} onUninstall={handleUninstallSkill} />
                  ))}
                </div>
              </div>
            )}
            {/* 自建技能 */}
            {filtered.filter(s => !s.installed).length > 0 && (
              <div>
                <p className="text-xs font-medium text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                  自建技能
                  <span className="text-[10px]">({filtered.filter(s => !s.installed).length})</span>
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {filtered.filter(s => !s.installed).map((skill) => (
                    <SkillCard key={skill.name} skill={skill} expanded={expandedIds.has(skill.name)} onToggle={() => handleCardClick(skill)} onToggleEnabled={(en) => handleToggleEnabled(skill.name, en)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-2">
            {filtered.map((skill) => (
              <SkillCard key={skill.name} skill={skill} expanded={expandedIds.has(skill.name)} onToggle={() => handleCardClick(skill)} />
            ))}
          </div>
        )
      )}
    </div>
    </>
  )
}

// ─── 已安装技能详情弹层 ────────────────────────────────────────────────────

interface InstalledSkillDetailModalProps {
  skill: Skill
  onClose: () => void
  onToggleEnabled?: (enabled: boolean) => void
  onUninstall?: () => void
}

function InstalledSkillDetailModal({ skill, onClose, onToggleEnabled, onUninstall }: InstalledSkillDetailModalProps) {
  const [uninstalling, setUninstalling] = useState(false)
  const [isEnabled, setIsEnabled] = useState(skill.enabled !== false)
  const iconBg = getSkillIconBg(skill.name)
  const initials = getSkillInitials(skill.name)

  const sourceBadge = skill.source === 'builtin'
    ? SOURCE_BADGE.builtin
    : (skill.installed ? INSTALLED_BADGE : CUSTOM_BADGE)

  async function handleUninstall() {
    setUninstalling(true)
    try {
      await uninstallMarketSkill(skill.name)
      onUninstall?.()
    } catch { /* 忽略 */ } finally {
      setUninstalling(false)
    }
  }

  function handleToggle(en: boolean) {
    setIsEnabled(en)
    onToggleEnabled?.(en)
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleBackdrop}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-2xl shadow-2xl w-[640px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-start gap-4 p-5 border-b border-[var(--border)]">
          <div className={`w-12 h-12 rounded-xl ${iconBg} flex items-center justify-center shrink-0 text-white text-sm font-bold shadow-sm`}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-base font-bold text-[var(--text-primary)] truncate">{skill.name}</h3>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${sourceBadge.className}`}>
                {sourceBadge.text}
              </span>
            </div>
            {skill.description && (
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{skill.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Prompt 内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          {skill.prompt ? (
            <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
              <MarkdownRenderer content={skill.prompt} />
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)] italic">暂无 prompt 内容</p>
          )}
        </div>

        {/* 底部操作（仅用户技能） */}
        {skill.source === 'user' && (
          <div className="p-4 border-t border-[var(--border)] flex items-center justify-between gap-3">
            {/* 卸载按钮（安装技能） */}
            {onUninstall ? (
              <button
                type="button"
                onClick={handleUninstall}
                disabled={uninstalling}
                className="px-4 py-1.5 text-sm font-medium rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {uninstalling ? (
                  <>
                    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" opacity="0.75" />
                    </svg>
                    卸载中...
                  </>
                ) : '卸载'}
              </button>
            ) : <span />}

            {/* 启用/禁用滑块 */}
            {onToggleEnabled && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--text-muted)]">{isEnabled ? '已启用' : '已禁用'}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  onClick={() => handleToggle(!isEnabled)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ${isEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 技能市场详情弹层 ──────────────────────────────────────────────────────

interface MarketDetailModalProps {
  skill: MarketSkill
  installedSlugs: Set<string>
  onClose: () => void
  onInstalled: (slug: string) => void
  onUninstalled: (slug: string) => void
}

function MarketDetailModal({ skill, installedSlugs, onClose, onInstalled, onUninstalled }: MarketDetailModalProps) {
  const [installing, setInstalling] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  // 用本地状态跟踪，方便安装/卸载后立即切换按钮
  const [localInstalled, setLocalInstalled] = useState(installedSlugs.has(skill.slug))
  const iconBg = getIconBg(skill.slug)
  const initials = getInitials(skill.name || skill.slug)

  async function handleInstall() {
    setInstalling(true)
    setActionMsg(null)
    try {
      await installMarketSkill(skill.slug)
      setActionMsg({ type: 'success', text: '安装成功' })
      setLocalInstalled(true)
      onInstalled(skill.slug)
    } catch (err) {
      setActionMsg({ type: 'error', text: err instanceof Error ? err.message : '安装失败' })
    } finally {
      setInstalling(false)
    }
  }

  async function handleUninstall() {
    setUninstalling(true)
    setActionMsg(null)
    try {
      await uninstallMarketSkill(skill.slug)
      setActionMsg({ type: 'success', text: '卸载成功' })
      setLocalInstalled(false)
      onUninstalled(skill.slug)
    } catch (err) {
      setActionMsg({ type: 'error', text: err instanceof Error ? err.message : '卸载失败' })
    } finally {
      setUninstalling(false)
    }
  }

  // 点击遮罩关闭
  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-2xl shadow-2xl w-[480px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-start gap-4 p-5 border-b border-[var(--border)]">
          <div className={`w-14 h-14 rounded-xl ${iconBg} flex items-center justify-center shrink-0 text-white text-base font-bold shadow-sm`}>
            {skill.icon ? (
              <img src={skill.icon} alt={skill.name} className="w-12 h-12 rounded-lg object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
            ) : initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-base font-bold text-[var(--text-primary)] truncate">{skill.name || skill.slug}</h3>
              {skill.version && <span className="text-xs text-[var(--text-muted)] shrink-0">v{skill.version}</span>}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {skill.category && (
                <span className={`text-[10px] px-2 py-0.5 rounded-md font-medium ${getCategoryColor(skill.category)}`}>
                  {skill.category}
                </span>
              )}
              {skill.author && <span className="text-xs text-[var(--text-muted)]">👤 {skill.author}</span>}
              {skill.downloads > 0 && <span className="text-xs text-[var(--text-muted)]">↓ {skill.downloads.toLocaleString()}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 描述 */}
        <div className="flex-1 overflow-y-auto p-5">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-4">
            {skill.description || '暂无描述'}
          </p>
          {skill.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {skill.tags.map(tag => (
                <span key={tag} className="text-[11px] px-2 py-0.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border)]">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* 操作结果消息 */}
          {actionMsg && (
            <div className={`mt-4 p-3 rounded-lg text-sm ${
              actionMsg.type === 'success'
                ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                : 'bg-red-500/10 border border-red-500/30 text-red-400'
            }`}>
              {actionMsg.type === 'success' ? '✓ ' : '✗ '}{actionMsg.text}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="p-4 border-t border-[var(--border)] flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--text-muted)] font-mono truncate">{skill.slug}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-sm text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg hover:text-[var(--text-primary)] transition-colors"
            >
              关闭
            </button>
            {localInstalled ? (
              <button
                type="button"
                onClick={handleUninstall}
                disabled={uninstalling}
                className="px-4 py-1.5 text-sm font-medium rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {uninstalling ? (
                  <>
                    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" opacity="0.25" />
                      <path d="M12 2a10 10 0 0 1 10 10" opacity="0.75" />
                    </svg>
                    卸载中...
                  </>
                ) : '卸载'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleInstall}
                disabled={installing}
                className="px-4 py-1.5 text-sm font-medium rounded-lg bg-[var(--accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {installing ? (
                  <>
                    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" opacity="0.25" />
                      <path d="M12 2a10 10 0 0 1 10 10" opacity="0.75" />
                    </svg>
                    安装中...
                  </>
                ) : '安装'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 技能市场卡片 ──────────────────────────────────────────────────────────

// 分类颜色映射
const CATEGORY_COLORS: Record<string, string> = {
  '开发工具': 'bg-blue-500/20 text-blue-400',
  '投资理财': 'bg-green-500/20 text-green-400',
  '内容创作': 'bg-purple-500/20 text-purple-400',
  '数据分析': 'bg-yellow-500/20 text-yellow-400',
  '效率工具': 'bg-cyan-500/20 text-cyan-400',
  '办公协同': 'bg-orange-500/20 text-orange-400',
  '商业运营': 'bg-pink-500/20 text-pink-400',
  '知识与学习': 'bg-indigo-500/20 text-indigo-400',
}

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
}

// 根据 slug 生成一个稳定的图标背景色
function getIconBg(slug: string): string {
  const colors = [
    'bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500',
    'bg-pink-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-yellow-500',
    'bg-red-500', 'bg-teal-500',
  ]
  let hash = 0
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) & 0xffffffff
  return colors[Math.abs(hash) % colors.length]
}

// 从名称取首字母作为图标
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

interface MarketCardProps {
  skill: MarketSkill
  isInstalled: boolean
  onClick: () => void
}

function MarketCard({ skill, isInstalled, onClick }: MarketCardProps) {
  const iconBg = getIconBg(skill.slug)
  const initials = getInitials(skill.name || skill.slug)

  return (
    <div
      className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] p-3 hover:border-[var(--accent)] hover:shadow-sm transition-all duration-150 cursor-pointer group flex flex-col gap-2"
      onClick={onClick}
    >
      {/* 图标 + 名称 */}
      <div className="flex items-center gap-2">
        <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center shrink-0 text-white text-xs font-bold shadow-sm`}>
          {skill.icon ? (
            <img src={skill.icon} alt={skill.name} className="w-7 h-7 rounded-md object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : initials}
        </div>
        <span className="text-xs font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors leading-tight">
          {skill.name || skill.slug}
        </span>
      </div>

      {/* 描述 */}
      <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2 leading-relaxed flex-1">
        {skill.description || '暂无描述'}
      </p>

      {/* 底部：分类 + 已安装标记 */}
      <div className="flex items-center justify-between gap-1">
        {skill.category ? (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${getCategoryColor(skill.category)}`}>
            {skill.category}
          </span>
        ) : <span />}
        {isInstalled && (
          <span className="text-[10px] text-green-400 font-medium shrink-0">✓ 已安装</span>
        )}
      </div>
    </div>
  )
}

// ─── 技能市场 Tab 内容 ─────────────────────────────────────────────────────

// 预设分类（参考图片中的 Tab 分类）
const MARKET_CATEGORIES = [
  '全部', '开发工具', '投资理财', '内容创作', '数据分析',
  '效率工具', '办公协同', '商业运营', '知识与学习',
]

// 每次加载的基础数量
const LIMIT_STEP = 20

function MarketPanel() {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('全部')
  const [results, setResults] = useState<MarketSkill[]>([])
  const [total, setTotal] = useState(0)
  const [loadCount, setLoadCount] = useState(1) // 加载次数：1 = 20个，2 = 40个，3 = 60个...
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<MarketSkill | null>(null)
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function buildSearchQuery(cat: string, q: string): string {
    const parts: string[] = []
    if (cat !== '全部') parts.push(cat)
    if (q.trim()) parts.push(q.trim())
    return parts.join(' ') || '技能'
  }

  async function doSearch(cat: string, q: string, count: number, isLoadMore = false) {
    if (isLoadMore) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    setHasSearched(true)
    try {
      const searchQ = buildSearchQuery(cat, q)
      const limit = count * LIMIT_STEP
      const data = await searchMarketSkills(searchQ, limit)
      setResults(data.results)
      setTotal(data.total)
      // 如果返回数量达到当前 limit，说明可能还有更多
      setHasMore(data.results.length >= limit)
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败，请稍后重试')
      setResults([])
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  // 初始加载：同时拉取搜索结果和已安装技能列表
  useEffect(() => {
    doSearch('全部', '', 1)
    // 从已安装列表初始化 installedSlugs
    getSkills().then(skills => {
      const slugs = new Set(skills.filter(s => s.source === 'user').map(s => s.name))
      setInstalledSlugs(slugs)
    }).catch(() => { /* 忽略，不影响主流程 */ })
  }, [])

  // 分类切换：重置到第 1 次加载
  function handleCategoryChange(cat: string) {
    setActiveCategory(cat)
    setLoadCount(1)
    doSearch(cat, query, 1)
  }

  // 搜索框防抖：重置到第 1 次加载
  function handleQueryChange(val: string) {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setLoadCount(1)
      doSearch(activeCategory, val, 1)
    }, 400)
  }

  async function refreshInstalledSlugs() {
    try {
      const skills = await getSkills()
      const slugs = new Set(skills.filter(s => s.source === 'user').map(s => s.name))
      setInstalledSlugs(slugs)
    } catch { /* 忽略 */ }
  }

  function handleCloseModal() {
    setSelectedSkill(null)
    refreshInstalledSlugs()
  }

  // 加载更多：次数 +1，请求 (count+1) * 20 个覆盖当前结果
  function handleLoadMore() {
    const nextCount = loadCount + 1
    setLoadCount(nextCount)
    doSearch(activeCategory, query, nextCount, true)
  }

  return (
    <>
      {/* 详情弹层 */}
      {selectedSkill && (
        <MarketDetailModal
          skill={selectedSkill}
          installedSlugs={installedSlugs}
          onClose={() => handleCloseModal()}
          onInstalled={(slug) => setInstalledSlugs(prev => new Set([...prev, slug]))}
          onUninstalled={(_slug) => { /* 卡片标识保留，不移除 */ }}
        />
      )}

    <div className="flex flex-col gap-4">
      {/* 搜索框 */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="搜索技能市场..."
          className="w-full pl-9 pr-4 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
      </div>

      {/* 分类 Tab 横向滚动 */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        {MARKET_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => handleCategoryChange(cat)}
            className={[
              'shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 whitespace-nowrap',
              activeCategory === cat
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)]',
            ].join(' ')}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* 结果统计 */}
      {hasSearched && !loading && !error && (
        <p className="text-xs text-[var(--text-muted)]">
          共找到 <span className="text-[var(--text-secondary)] font-medium">{total}</span> 个技能
        </p>
      )}

      {/* 加载中 */}
      {loading && (
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: 30 }).map((_, i) => (
            <div key={i} className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] p-3 animate-pulse">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-9 h-9 rounded-lg bg-[var(--bg-tertiary)] shrink-0" />
                <div className="h-3 flex-1 bg-[var(--bg-tertiary)] rounded" />
              </div>
              <div className="space-y-1.5">
                <div className="h-2.5 w-full bg-[var(--bg-tertiary)] rounded" />
                <div className="h-2.5 w-3/4 bg-[var(--bg-tertiary)] rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 错误 */}
      {!loading && error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          <span className="font-medium">搜索失败：</span>{error}
          <button
            type="button"
            onClick={() => doSearch(activeCategory, query, loadCount)}
            className="ml-2 underline hover:no-underline"
          >
            重试
          </button>
        </div>
      )}

      {/* 空结果 */}
      {!loading && !error && hasSearched && results.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--text-secondary)]">
          <span className="text-4xl mb-3">🔍</span>
          <p className="text-sm font-medium mb-1">未找到相关技能</p>
          <p className="text-xs text-[var(--text-muted)]">换个关键词试试</p>
        </div>
      )}

      {/* 技能卡片网格 - 每排5个 */}
      {!loading && !error && results.length > 0 && (
        <>
          <div className="grid grid-cols-5 gap-2">
            {results.map((skill) => (
              <MarketCard
                key={skill.slug}
                skill={skill}
                isInstalled={installedSlugs.has(skill.slug)}
                onClick={() => setSelectedSkill(skill)}
              />
            ))}
          </div>

          {/* 加载更多按钮 */}
          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="px-6 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingMore ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" opacity="0.25" />
                      <path d="M12 2a10 10 0 0 1 10 10" opacity="0.75" />
                    </svg>
                    加载中...
                  </span>
                ) : (
                  '加载更多'
                )}
              </button>
            </div>
          )}
        </>
      )}
    </div>
    </>
  )
}

// ─── MCP 服务 Tab（预留） ──────────────────────────────────────────────────

function McpPanel() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-[var(--text-secondary)]">
      <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border)] flex items-center justify-center mb-4">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      </div>
      <p className="text-sm font-medium text-[var(--text-primary)] mb-1">MCP 服务</p>
      <p className="text-xs text-[var(--text-muted)] text-center max-w-[200px] leading-relaxed">
        Model Context Protocol 服务管理，即将上线
      </p>
    </div>
  )
}

// ─── SkillsPage ────────────────────────────────────────────────────────────

export function SkillsPage() {
  const [mainTab, setMainTab] = useState<MainTab>('installed')
  const [allSkills, setAllSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await getSkills()
        if (!cancelled) setAllSkills(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败，请稍后重试')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* 顶部主 Tab */}
      <div className="shrink-0 px-4 pt-4 pb-0">
        <div className="flex gap-0 border-b border-[var(--border)]">
          {MAIN_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setMainTab(tab.value)}
              className={[
                'px-4 py-2 text-sm font-medium transition-all duration-150 border-b-2 -mb-px',
                mainTab === tab.value
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab 内容区 */}
      <div className="flex-1 overflow-y-auto p-4">
        {mainTab === 'installed' && (
          <InstalledPanel skills={allSkills} loading={loading} error={error} />
        )}
        {mainTab === 'market' && <MarketPanel />}
        {mainTab === 'mcp' && <McpPanel />}
      </div>
    </div>
  )
}
