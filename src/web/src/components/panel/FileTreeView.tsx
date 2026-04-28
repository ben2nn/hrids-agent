import { useEffect } from 'react'
import { useFileTreeStore } from '../../store/fileTreeStore.js'
import { FileTreeNode } from './FileTreeNode.js'

// 稳定的空 Set 默认值，避免每次渲染产生新引用触发无限重渲染
const EMPTY_LOADING_SET = new Set<string>()

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface FileTreeViewProps {
  sessionId: string
  onInsertText?: (text: string) => void
}

// ─── FileTreeView 组件 ─────────────────────────────────────────────────────

export function FileTreeView({ sessionId, onInsertText }: FileTreeViewProps) {
  const tree = useFileTreeStore((s) => s.trees.get(sessionId))
  const cwd = useFileTreeStore((s) => s.cwds.get(sessionId) ?? '')
  const rootLoading = useFileTreeStore((s) => s.loading.get(sessionId) ?? EMPTY_LOADING_SET)

  useEffect(() => {
    useFileTreeStore.getState().initSession(sessionId)
  }, [sessionId])

  const isRootLoading = rootLoading.has('.') || rootLoading.has('')
  const rootChildren = tree?.children ?? []

  return (
    <div className="flex flex-col h-full">
      {/* 顶部：cwd 路径 + 刷新按钮 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0 bg-[var(--bg-secondary)]">
        <svg
          className="text-[var(--accent)] shrink-0 opacity-70"
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span
          className="flex-1 text-[10px] text-[var(--text-muted)] truncate font-mono leading-none"
          title={cwd || '（未知工作目录）'}
        >
          {cwd || '（未知工作目录）'}
        </span>

        {/* 刷新按钮 */}
        <button
          type="button"
          onClick={() => useFileTreeStore.getState().refresh(sessionId)}
          disabled={isRootLoading}
          className="text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 p-1 rounded-md hover:bg-[var(--bg-tertiary)]"
          aria-label="刷新文件树"
          title="刷新"
        >
          <svg
            className={isRootLoading ? 'animate-spin' : ''}
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {/* 文件树内容区域 */}
      <div className="flex-1 overflow-y-auto py-1.5 px-1">
        {isRootLoading && rootChildren.length === 0 ? (
          // 骨架屏
          <div className="px-3 py-2 space-y-2">
            {[75, 55, 85, 60, 70].map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded skeleton shrink-0" />
                <div className="h-3 skeleton rounded" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        ) : rootChildren.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[100px] gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center">
              <svg className="text-[var(--text-muted)] opacity-50" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <span className="text-xs text-[var(--text-muted)]">目录为空</span>
          </div>
        ) : (
          rootChildren.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              sessionId={sessionId}
              depth={0}
              onInsertText={onInsertText}
            />
          ))
        )}
      </div>
    </div>
  )
}

export default FileTreeView
