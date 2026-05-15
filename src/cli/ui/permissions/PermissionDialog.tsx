import React from 'react'
import { BashPermissionRequest } from './BashPermissionRequest.js'
import { FileEditPermissionRequest } from './FileEditPermissionRequest.js'
import { FilesystemPermissionRequest } from './FilesystemPermissionRequest.js'
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js'
import type { PermissionDecision } from '../PermissionRequest.js'
import { getToolDisplayName } from '../theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export type PermissionToolType = 'bash' | 'file_edit' | 'filesystem' | 'fallback'

interface PermissionDialogProps {
  /** 工具类型 */
  toolType: PermissionToolType
  /** 工具名称 */
  toolName: string
  /** 工具输入 */
  input: Record<string, unknown>
  /** 权限描述 */
  description?: string
  /** 回调 */
  onDecision: (decision: PermissionDecision) => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 权限对话框分发器
 *
 * 根据工具类型分发到对应的权限 UI 组件。
 */
export function PermissionDialog({
  toolType,
  toolName,
  input,
  description,
  onDecision,
}: PermissionDialogProps) {
  switch (toolType) {
    case 'bash':
      return (
        <BashPermissionRequest
          command={(input.command as string) ?? ''}
          description={description}
          isDangerous={input.isDangerous as boolean}
          onDecision={onDecision}
        />
      )

    case 'file_edit':
      return (
        <FileEditPermissionRequest
          filePath={(input.file_path as string) ?? ''}
          editType={(input.edit_type as 'create' | 'modify' | 'delete') ?? 'modify'}
          diffPreview={input.diff_preview as string}
          onDecision={onDecision}
        />
      )

    case 'filesystem':
      return (
        <FilesystemPermissionRequest
          toolName={toolName}
          operation={description ?? '访问文件系统'}
          path={input.path as string}
          isReadOnly={input.is_read_only as boolean}
          onDecision={onDecision}
        />
      )

    case 'fallback':
    default:
      return (
        <FallbackPermissionRequest
          toolName={toolName}
          inputSummary={JSON.stringify(input).slice(0, 100)}
          description={description}
          onDecision={onDecision}
        />
      )
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 根据工具名称判断工具类型
 */
export function getPermissionToolType(toolName: string): PermissionToolType {
  const name = toolName.toLowerCase()
  if (name === 'bash' || name === 'bashtool') return 'bash'
  if (name === 'file_edit' || name === 'fileedittool' || name === 'edit') return 'file_edit'
  if (name === 'file_read' || name === 'filereadtool' || name === 'read' ||
      name === 'glob' || name === 'globtool' || name === 'grep' || name === 'greptool') return 'filesystem'
  return 'fallback'
}
