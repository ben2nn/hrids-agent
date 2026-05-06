import { useEffect, useRef, useState, useCallback } from 'react'
import { getFileContent, saveFileContent, previewFile } from '../../lib/gateway.js'
import type { FilePreviewResult } from '../../lib/gateway.js'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface FileContentModalProps {
  sessionId: string
  filePath: string
  onClose: () => void
  onInsertRef?: (text: string) => void
}

// ─── 文件类型分类 ──────────────────────────────────────────────────────────

type FileKind = 'text' | 'office' | 'binary'

function getFileKind(name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['docx', 'doc', 'xlsx', 'xls', 'csv'].includes(ext)) return 'office'
  const binaryExts = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
    'pdf', 'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
    'exe', 'dll', 'so', 'dylib', 'bin', 'wasm',
    'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov',
    'ttf', 'woff', 'woff2', 'eot',
    'lock',
  ])
  return binaryExts.has(ext) ? 'binary' : 'text'
}

// ─── 根据扩展名推断语言标签 ────────────────────────────────────────────────

function getLangLabel(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
    json: 'JSON', md: 'Markdown', css: 'CSS', html: 'HTML',
    py: 'Python', rs: 'Rust', go: 'Go', sh: 'Shell',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML', env: 'ENV',
    txt: 'Text', xml: 'XML', sql: 'SQL',
    docx: 'Word', doc: 'Word', xlsx: 'Excel', xls: 'Excel', csv: 'CSV',
  }
  return map[ext] ?? (ext.toUpperCase() || 'Text')
}

// ─── Excel 表格渲染 ────────────────────────────────────────────────────────

interface SheetViewProps {
  sheets: Array<{ name: string; headers: string[]; rows: string[][] }>
}

function SheetView({ sheets }: SheetViewProps) {
  const [activeSheet, setActiveSheet] = useState(0)
  const sheet = sheets[activeSheet]

  return (
    <div>
      {/* Sheet 标签栏（多 sheet 时显示） */}
      {sheets.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-[var(--border-subtle)] overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={`px-3 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors ${
                i === activeSheet
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 表格内容 */}
      {sheet.headers.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-[var(--text-muted)] text-sm">
          空表格
        </div>
      ) : (
        <table className="w-full text-[11px] font-mono border-collapse">
          <thead className="sticky top-0 z-10 bg-[var(--bg-secondary)]">
            <tr>
              <th className="w-10 px-2 py-1.5 text-right text-[var(--text-muted)] border-b border-r border-[var(--border-subtle)] font-normal select-none" />
              {sheet.headers.map((h, i) => (
                <th
                  key={i}
                  className="px-3 py-1.5 text-left text-[var(--text-secondary)] font-semibold border-b border-r border-[var(--border-subtle)] whitespace-nowrap"
                >
                  {h || <span className="text-[var(--text-muted)] italic">（空）</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri} className="hover:bg-[var(--bg-tertiary)] transition-colors">
                <td className="px-2 py-1 text-right text-[var(--text-muted)] border-b border-r border-[var(--border-subtle)] select-none">
                  {ri + 1}
                </td>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1 text-[var(--text-primary)] border-b border-r border-[var(--border-subtle)] whitespace-nowrap max-w-[240px] truncate"
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ─── Word HTML 渲染 ────────────────────────────────────────────────────────

function DocView({ html }: { html: string }) {
  return (
    <div className="px-8 py-6">
      <div
        className="prose prose-sm max-w-none text-[var(--text-primary)] [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-2 [&_h3]:font-semibold [&_h3]:mb-1.5 [&_p]:mb-2 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2 [&_li]:mb-0.5 [&_table]:border-collapse [&_table]:w-full [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1 [&_th]:bg-[var(--bg-secondary)] [&_strong]:font-semibold [&_em]:italic [&_a]:text-[var(--accent)] [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

// ─── FileContentModal 组件 ─────────────────────────────────────────────────

export function FileContentModal({ sessionId, filePath, onClose, onInsertRef }: FileContentModalProps) {
  const [content, setContent] = useState<string>('')
  const [editContent, setEditContent] = useState<string>('')
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [isDirty, setIsDirty] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileName = filePath.split('/').pop() ?? filePath
  const fileKind = getFileKind(fileName)

  // 加载文件内容
  useEffect(() => {
    setLoading(true)
    setError(null)
    setPreview(null)

    if (fileKind === 'binary') {
      setLoading(false)
      return
    }

    if (fileKind === 'office') {
      previewFile(sessionId, filePath)
        .then(setPreview)
        .catch((err) => setError(String(err)))
        .finally(() => setLoading(false))
      return
    }

    // text
    getFileContent(sessionId, filePath)
      .then((res) => {
        setContent(res.content)
        setEditContent(res.content)
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [sessionId, filePath, fileKind])

  // 进入编辑模式时聚焦 textarea
  useEffect(() => {
    if (isEditing) {
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [isEditing])

  // ESC 关闭
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (isEditing && isDirty) {
          if (confirm('有未保存的修改，确定放弃？')) onClose()
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, isEditing, isDirty])

  const handleEdit = useCallback(() => {
    setEditContent(content)
    setIsDirty(false)
    setIsEditing(true)
  }, [content])

  const handleCancelEdit = useCallback(() => {
    if (isDirty && !confirm('有未保存的修改，确定放弃？')) return
    setIsEditing(false)
    setIsDirty(false)
    setEditContent(content)
  }, [isDirty, content])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await saveFileContent(sessionId, filePath, editContent)
      setContent(editContent)
      setIsDirty(false)
      setIsEditing(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (err) {
      setError(`保存失败: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [sessionId, filePath, editContent])

  const handleInsertRef = useCallback(() => {
    onInsertRef?.('@' + filePath)
    onClose()
  }, [onInsertRef, filePath, onClose])

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditContent(e.target.value)
    setIsDirty(true)
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      handleSave()
    }
  }, [handleSave])

  const displayText = isEditing ? editContent : content
  const lines = displayText.split('\n')
  const lineCount = lines.length

  // 底部状态栏信息
  const statusInfo = fileKind === 'text'
    ? `${lineCount} 行 · ${displayText.length} 字符`
    : fileKind === 'office' && preview?.type === 'table'
      ? `${preview.sheets.length} 个工作表`
      : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={`文件内容：${fileName}`}
    >
      {/* 弹框主体 */}
      <div className="relative flex flex-col w-[860px] max-w-[95vw] max-h-[85vh] bg-[var(--bg-primary)] border border-[var(--border)] rounded-2xl shadow-[var(--shadow-lg)] overflow-hidden">

        {/* 标题栏 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)] shrink-0 bg-[var(--bg-secondary)]">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-sm font-semibold text-[var(--text-primary)] truncate font-mono">
              {fileName}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)] font-mono shrink-0">
              {getLangLabel(fileName)}
            </span>
            {isDirty && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--accent)]/20 text-[var(--accent)] font-medium shrink-0">
                已修改
              </span>
            )}
            {saveSuccess && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-green-500/20 text-green-400 font-medium shrink-0">
                ✓ 已保存
              </span>
            )}
          </div>

          <span
            className="text-[10px] text-[var(--text-muted)] font-mono truncate max-w-[200px] shrink-0"
            title={filePath}
          >
            {filePath}
          </span>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* 插入引用 */}
            {onInsertRef && (
              <button
                type="button"
                onClick={handleInsertRef}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] border border-[var(--border)] transition-all duration-150"
                title="插入文件引用到输入框"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                引用
              </button>
            )}

            {/* 编辑按钮（仅文本文件） */}
            {fileKind === 'text' && !loading && !error && (
              isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] transition-all duration-150"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !isDirty}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
                    title="保存 (Ctrl+S)"
                  >
                    {saving ? (
                      <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                        <polyline points="17 21 17 13 7 13 7 21" />
                        <polyline points="7 3 7 8 15 8" />
                      </svg>
                    )}
                    保存
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleEdit}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] border border-[var(--border)] transition-all duration-150"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  编辑
                </button>
              )
            )}

            {/* 关闭 */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-all duration-150"
              aria-label="关闭"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 min-h-0 overflow-auto relative">

          {/* 加载中 */}
          {loading && (
            <div className="flex items-center justify-center h-full min-h-[200px] gap-2 text-[var(--text-muted)] text-sm">
              <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              加载中…
            </div>
          )}

          {/* 错误 */}
          {!loading && error && (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] gap-3 text-sm px-6">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                <svg className="text-red-400" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <p className="text-[var(--text-secondary)] text-center">{error}</p>
            </div>
          )}

          {/* 二进制文件 */}
          {!loading && !error && fileKind === 'binary' && (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] gap-3 text-sm px-6">
              <div className="w-10 h-10 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center text-xl">📦</div>
              <p className="text-[var(--text-muted)] text-center">二进制文件，无法预览</p>
            </div>
          )}

          {/* Office 文件预览 */}
          {!loading && !error && fileKind === 'office' && preview && (
            preview.type === 'html'
              ? <DocView html={preview.html} />
              : <SheetView sheets={preview.sheets} />
          )}

          {/* 文本文件 */}
          {!loading && !error && fileKind === 'text' && (
            isEditing ? (
              <div className="flex overflow-auto">
                <div
                  className="sticky left-0 z-10 select-none text-right text-[11px] font-mono text-[var(--text-muted)] bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] px-3 py-4 shrink-0 leading-[1.6] self-start"
                  aria-hidden="true"
                  style={{ minWidth: '3rem' }}
                >
                  {lines.map((_, i) => <div key={i + 1}>{i + 1}</div>)}
                </div>
                <textarea
                  ref={textareaRef}
                  value={editContent}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  rows={lineCount}
                  className="flex-1 resize-none bg-[var(--bg-primary)] text-[var(--text-primary)] text-[12px] font-mono leading-[1.6] px-4 py-4 outline-none min-w-0 overflow-hidden"
                  spellCheck={false}
                  aria-label="文件内容编辑器"
                />
              </div>
            ) : (
              <div className="flex overflow-auto">
                <div
                  className="sticky left-0 z-10 select-none text-right text-[11px] font-mono text-[var(--text-muted)] bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] px-3 py-4 shrink-0 leading-[1.6] self-start"
                  aria-hidden="true"
                  style={{ minWidth: '3rem' }}
                >
                  {lines.map((_, i) => <div key={i + 1}>{i + 1}</div>)}
                </div>
                <pre className="flex-1 text-[12px] font-mono leading-[1.6] px-4 py-4 text-[var(--text-primary)] whitespace-pre min-w-0">
                  {content}
                </pre>
              </div>
            )
          )}
        </div>

        {/* 底部状态栏 */}
        {!loading && !error && statusInfo && (
          <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] shrink-0">
            <span className="text-[10px] text-[var(--text-muted)] font-mono">{statusInfo}</span>
            {isEditing && (
              <span className="text-[10px] text-[var(--text-muted)] ml-auto">
                Ctrl+S 保存 · ESC 关闭
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default FileContentModal
