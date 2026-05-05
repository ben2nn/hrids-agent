import React, { useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Components } from 'react-markdown'

// ─── Props ────────────────────────────────────────────────────────────────

interface MarkdownRendererProps {
  content: string
  className?: string
}

// ─── 代码块（带语言标题 + 复制按钮） ─────────────────────────────────────

function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [children])

  return React.createElement(
    'div',
    { className: 'my-3 rounded-lg overflow-hidden border border-white/10' },
    // 标题栏：语言 + 复制按钮
    React.createElement(
      'div',
      { className: 'flex items-center justify-between px-3 py-1.5 bg-[#1a1a2e] border-b border-white/10' },
      React.createElement(
        'span',
        { className: 'text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider' },
        language,
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: handleCopy,
          className: [
            'flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded transition-all duration-150',
            copied
              ? 'text-emerald-400 bg-emerald-400/10'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-white/5',
          ].join(' '),
          'aria-label': copied ? '已复制' : '复制代码',
        },
        copied
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'svg',
                { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
                React.createElement('polyline', { points: '20 6 9 17 4 12' }),
              ),
              '已复制',
            )
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'svg',
                { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
                React.createElement('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }),
                React.createElement('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
              ),
              '复制',
            ),
      ),
    ),
    // 代码内容
    React.createElement(SyntaxHighlighter, {
      style: oneDark,
      language,
      PreTag: 'div',
      customStyle: {
        margin: 0,
        borderRadius: 0,
        fontSize: '0.8125rem',
        background: '#1e1e2e',
        padding: '0.875rem',
      },
      children,
    }),
  )
}

// ─── 自定义渲染组件 ────────────────────────────────────────────────────────

const markdownComponents: Components = {
  // 代码：内联 or 块级
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '')
    const isInline = !match

    if (isInline) {
      return React.createElement(
        'code',
        {
          className: 'font-mono text-[0.8125em] bg-white/8 text-orange-300 px-1.5 py-0.5 rounded border border-white/10',
          ...props,
        },
        children,
      )
    }

    const language = match[1]
    const codeString = String(children).replace(/\n$/, '')
    return React.createElement(CodeBlock, { language, children: codeString })
  },

  // 标题
  h1({ children }) {
    return React.createElement(
      'h1',
      { className: 'text-lg font-bold text-[var(--text-primary)] mt-5 mb-2 first:mt-0 border-b border-[var(--border-subtle)] pb-1.5' },
      children,
    )
  },
  h2({ children }) {
    return React.createElement(
      'h2',
      { className: 'text-base font-semibold text-[var(--text-primary)] mt-4 mb-1.5 first:mt-0' },
      children,
    )
  },
  h3({ children }) {
    return React.createElement(
      'h3',
      { className: 'text-sm font-semibold text-[var(--text-primary)] mt-3 mb-1 first:mt-0' },
      children,
    )
  },

  // 段落
  p({ children }) {
    return React.createElement(
      'p',
      { className: 'text-sm leading-relaxed text-[var(--text-primary)] mb-2 last:mb-0' },
      children,
    )
  },

  // 无序列表
  ul({ children }) {
    return React.createElement(
      'ul',
      { className: 'list-disc list-outside pl-4 mb-2 space-y-0.5 text-sm text-[var(--text-primary)]' },
      children,
    )
  },

  // 有序列表
  ol({ children }) {
    return React.createElement(
      'ol',
      { className: 'list-decimal list-outside pl-4 mb-2 space-y-0.5 text-sm text-[var(--text-primary)]' },
      children,
    )
  },

  // 列表项
  li({ children }) {
    return React.createElement(
      'li',
      { className: 'leading-relaxed pl-0.5' },
      children,
    )
  },

  // 引用块
  blockquote({ children }) {
    return React.createElement(
      'blockquote',
      { className: 'border-l-2 border-[var(--accent)] pl-3 my-2 text-[var(--text-secondary)] italic' },
      children,
    )
  },

  // 分割线
  hr() {
    return React.createElement('hr', { className: 'border-[var(--border-subtle)] my-3' })
  },

  // 链接
  a({ href, children }) {
    return React.createElement(
      'a',
      {
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
        className: 'text-[var(--accent-light,#60a5fa)] underline underline-offset-2 hover:opacity-80 transition-opacity',
      },
      children,
    )
  },

  // 粗体
  strong({ children }) {
    return React.createElement(
      'strong',
      { className: 'font-semibold text-[var(--text-primary)]' },
      children,
    )
  },

  // 斜体
  em({ children }) {
    return React.createElement(
      'em',
      { className: 'italic text-[var(--text-secondary)]' },
      children,
    )
  },

  // 表格
  table({ children }) {
    return React.createElement(
      'div',
      { className: 'overflow-x-auto my-3' },
      React.createElement(
        'table',
        {
          className: 'w-full text-xs border-collapse border border-[var(--border-subtle)] rounded-lg overflow-hidden',
          style: { tableLayout: 'fixed' },
        },
        children,
      ),
    )
  },
  thead({ children }) {
    return React.createElement(
      'thead',
      { className: 'bg-[var(--bg-tertiary)]' },
      children,
    )
  },
  tbody({ children }) {
    return React.createElement(
      'tbody',
      { className: '[&>tr:nth-child(even)]:bg-[var(--bg-secondary)] [&>tr:nth-child(odd)]:bg-transparent [&>tr:last-child>td]:border-b-0' },
      children,
    )
  },
  tr({ children }) {
    return React.createElement(
      'tr',
      { className: 'hover:bg-[var(--bg-tertiary)] transition-colors duration-100' },
      children,
    )
  },
  th({ children }) {
    return React.createElement(
      'th',
      { className: 'text-left px-3 py-2 text-[var(--text-muted)] font-semibold border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wider break-words' },
      children,
    )
  },
  td({ children }) {
    return React.createElement(
      'td',
      { className: 'px-3 py-2 text-[var(--text-secondary)] border-b border-[var(--border-subtle)] align-top break-words' },
      children,
    )
  },
}

// ─── MarkdownRenderer 组件 ─────────────────────────────────────────────────

export function MarkdownRenderer({ content, className }: MarkdownRendererProps): React.ReactElement {
  return React.createElement(
    'div',
    { className: `text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${className ?? ''}` },
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm],
      components: markdownComponents,
      children: content,
    }),
  )
}
