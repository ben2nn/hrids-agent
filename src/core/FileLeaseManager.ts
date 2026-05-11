// 文件租约管理器 —— 防止并行子智能体写冲突的进程内软锁
//
// 定位：协作式锁，不是强制性安全边界。
// 用途：多个子智能体并行执行时，避免同时写入同一文件导致数据丢失。
// 局限：仅在同一进程内有效，不防止外部进程修改文件。

export interface LeaseInfo {
  /** 持有租约的智能体标识 */
  agentId: string
  /** 租约获取时间 */
  acquiredAt: number
  /** 租约操作描述（如 "编辑文件"、"写入配置"） */
  operation?: string
}

export interface LeaseResult {
  granted: boolean
  /** 租约被拒绝时，当前持有者信息 */
  holder?: LeaseInfo
}

/** 租约 TTL：10 分钟未释放的租约自动过期（防止智能体崩溃后永久阻塞） */
const LEASE_TTL_MS = 10 * 60 * 1000

export class FileLeaseManager {
  /** filePath → LeaseInfo */
  private leases = new Map<string, LeaseInfo>()

  /**
   * 尝试获取文件租约。
   * 获取前先清理过期租约，防止崩溃的智能体永久阻塞。
   * @returns granted=true 表示成功获取；granted=false 时 holder 为当前持有者
   */
  acquire(agentId: string, filePath: string, operation?: string): LeaseResult {
    const normalized = this.normalize(filePath)
    this.sweep()

    const existing = this.leases.get(normalized)
    if (existing && existing.agentId !== agentId) {
      return { granted: false, holder: existing }
    }

    // 同一智能体重复获取同一文件的租约 → 幂等成功
    this.leases.set(normalized, {
      agentId,
      acquiredAt: Date.now(),
      operation,
    })
    return { granted: true }
  }

  /**
   * 释放指定智能体持有的某个文件的租约。
   */
  release(agentId: string, filePath: string): boolean {
    const normalized = this.normalize(filePath)
    const existing = this.leases.get(normalized)
    if (existing && existing.agentId === agentId) {
      this.leases.delete(normalized)
      return true
    }
    return false
  }

  /**
   * 释放指定智能体持有的所有租约（智能体完成/取消时调用）。
   */
  releaseAll(agentId: string): number {
    let count = 0
    for (const [path, lease] of this.leases) {
      if (lease.agentId === agentId) {
        this.leases.delete(path)
        count++
      }
    }
    return count
  }

  /**
   * 清理过期租约。在 acquire 时自动调用。
   */
  private sweep(): void {
    const now = Date.now()
    for (const [path, lease] of this.leases) {
      if (now - lease.acquiredAt > LEASE_TTL_MS) {
        this.leases.delete(path)
      }
    }
  }

  private normalize(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  }
}

// ── 进程级单例 ──────────────────────────────────────────────────────────────
let _global: FileLeaseManager | null = null

export function getFileLeaseManager(): FileLeaseManager {
  if (!_global) _global = new FileLeaseManager()
  return _global
}
