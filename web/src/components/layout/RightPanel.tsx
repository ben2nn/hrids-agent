import { useState } from 'react'
import type { RefObject } from 'react'
import type { InputBarHandle } from '../chat/InputBar.js'
import { TodoArtifacts } from '../panel/TodoArtifacts.js'
import { FileTreeView } from '../panel/FileTreeView.js'

// ─── Tab 类型 ──────────────────────────────────────────────────────────────

type TabId = 'todos' | 'files'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface RightPanelProps {
  sessionId: string | null
  inputBarRef?: RefObject<InputBarHandle>
}

// ─── RightPanel 组件 ───────────────────────────────────────────────────────

export function RightPanel({ sessionId, inputBarRef }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('todos')

  if (!sessionId) {
    return null
  }

  const handleInsertText = (text: string) => {
    inputBarRef?.current?.insertText(text)
  }

  return (
    <div
      className="flex flex-col w-[280px] bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] shrink-0 overflow-hidden"
      aria-label="右侧面板"
    >
      {/* Tab 栏 — h-11 与主面板标题栏对齐 */}
      <div className="h-11 flex items-end border-b border-[var(--border-subtle)] shrink-0 px-3 gap-1">
        {/* Tab 按钮组 */}
        <div className="flex flex-1 gap-1">
          {([
            {
              id: 'todos' as TabId,
              label: '任务列表',
              icon: (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 11 12 14 22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              ),
            },
            {
              id: 'files' as TabId,
              label: '工作目录',
              icon: (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              ),
            },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-all duration-150 rounded-t-md ${
                activeTab === tab.id
                  ? 'text-[var(--text-primary)] bg-[var(--bg-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              aria-selected={activeTab === tab.id}
              role="tab"
            >
              {tab.icon}
              {tab.label}
              {/* 激活指示线 */}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--accent)] rounded-t-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab 内容区域 */}
      <div className="flex-1 overflow-hidden bg-[var(--bg-primary)]" role="tabpanel">
        {activeTab === 'todos' ? (
          <TodoArtifacts sessionId={sessionId} />
        ) : (
          <FileTreeView sessionId={sessionId} onInsertText={handleInsertText} />
        )}
      </div>
    </div>
  )
}

export default RightPanel
