import { useCallback, useRef, useState } from 'react'
import type { FileNode } from '../../lib/types.js'
import { useFileTreeStore } from '../../store/fileTreeStore.js'
import { FileContentModal } from './FileContentModal.js'

// 稳定的空 Set 默认值，避免每次渲染产生新引用触发无限重渲染
const EMPTY_SET = new Set<string>()

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface FileTreeNodeProps {
  node: FileNode
  sessionId: string
  depth: number
  onInsertText?: (text: string) => void
}

// ─── 文件图标（根据扩展名） ────────────────────────────────────────────────

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const iconMap: Record<string, string> = {
    ts: '🔷', tsx: '🔷', js: '🟡', jsx: '🟡',
    json: '📋', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', rs: '🦀', go: '🐹', sh: '⚙️',
    env: '🔒', gitignore: '🚫', lock: '🔐',
    png: '🖼', jpg: '🖼', jpeg: '🖼', svg: '🖼', gif: '🖼',
    pdf: '📄', zip: '📦', tar: '📦', gz: '📦',
  }
  return iconMap[ext] ?? '📄'
}

// ─── FileTreeNode 组件 ─────────────────────────────────────────────────────

export function FileTreeNode({ node, sessionId, depth, onInsertText }: FileTreeNodeProps) {
  const expanded = useFileTreeStore((s) => s.expanded.get(sessionId) ?? EMPTY_SET)
  const loading = useFileTreeStore((s) => s.loading.get(sessionId) ?? EMPTY_SET)
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand)

  // 文件内容弹框状态
  const [modalOpen, setModalOpen] = useState(false)

  // 双击检测：记录上次点击时间
  const lastClickRef = useRef<number>(0)

  const isExpanded = expanded.has(node.path)
  const isLoading = loading.has(node.path)

  // 隐藏文件（以 . 开头）使用更淡的颜色
  const isHidden = node.name.startsWith('.')
  const textColor = isHidden ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'
  const hoverTextColor = isHidden ? 'hover:text-[var(--text-secondary)]' : 'hover:text-[var(--text-primary)]'

  // ── 目录节点 ───────────────────────────────────────────────────────────
  if (node.type === 'dir') {
    return (
      <div>
        {/* 目录行 */}
        <button
          type="button"
          className={`flex items-center gap-1.5 w-full text-left py-0.5 hover:bg-[var(--bg-tertiary)] rounded-md transition-all duration-100 text-xs ${textColor} ${hoverTextColor} group`}
          style={{ paddingLeft: depth * 12 + 8, paddingRight: 8 }}
          onClick={() => toggleExpand(sessionId, node.path)}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? '折叠' : '展开'}目录 ${node.name}`}
        >
          {/* 展开/折叠箭头 */}
          {isLoading ? (
            <svg className="animate-spin text-[var(--text-muted)] shrink-0" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg
              className={`text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
              width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          )}

          {/* 文件夹图标 */}
          <span className="text-[11px] shrink-0">{isExpanded ? '📂' : '📁'}</span>

          {/* 目录名称 */}
          <span className="truncate">{node.name}</span>
        </button>

        {/* 子节点（展开时渲染） */}
        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                sessionId={sessionId}
                depth={depth + 1}
                onInsertText={onInsertText}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── 文件节点 ───────────────────────────────────────────────────────────
  // 单击：打开文件内容弹框；双击（300ms 内连续两次点击）：插入引用
  const handleFileClick = useCallback(() => {
    const now = Date.now()
    const isDoubleClick = now - lastClickRef.current < 300
    lastClickRef.current = now

    if (isDoubleClick) {
      // 双击：插入引用
      onInsertText?.('@' + node.path)
    } else {
      // 单击：打开弹框（延迟 250ms，等待可能的第二次点击）
      setTimeout(() => {
        if (Date.now() - lastClickRef.current >= 250) {
          setModalOpen(true)
        }
      }, 260)
    }
  }, [node.path, onInsertText])

  return (
    <>
      <button
        type="button"
        className={`flex items-center gap-1.5 w-full text-left py-0.5 hover:bg-[var(--bg-tertiary)] rounded-md transition-all duration-100 text-xs ${textColor} ${hoverTextColor} group`}
        style={{ paddingLeft: depth * 12 + 8 + 9 + 6, paddingRight: 8 }}
        onClick={handleFileClick}
        aria-label={`查看文件 ${node.path}，双击插入引用`}
        title={`${node.path}\n单击查看 · 双击插入引用`}
      >
        {/* 文件图标 */}
        <span className="text-[11px] shrink-0">{getFileIcon(node.name)}</span>

        {/* 文件名称 */}
        <span className="truncate">{node.name}</span>
      </button>

      {/* 文件内容弹框 */}
      {modalOpen && (
        <FileContentModal
          sessionId={sessionId}
          filePath={node.path}
          onClose={() => setModalOpen(false)}
          onInsertRef={onInsertText}
        />
      )}
    </>
  )
}

export default FileTreeNode
