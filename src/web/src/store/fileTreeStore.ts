import { create } from 'zustand'
import { listFiles } from '../lib/gateway.js'
import type { FileNode, FileListResponse } from '../lib/types.js'

// ─── Store 类型定义 ────────────────────────────────────────────────────────

interface FileTreeState {
  /** 每个会话的文件树根节点（key: sessionId） */
  trees: Map<string, FileNode>
  /** 每个会话已展开的目录路径集合（key: sessionId） */
  expanded: Map<string, Set<string>>
  /** 每个会话正在加载的路径集合（key: sessionId） */
  loading: Map<string, Set<string>>
  /** 每个会话的当前工作目录（key: sessionId） */
  cwds: Map<string, string>

  /**
   * 加载指定会话的目录内容（懒加载）。
   * 调用 listFiles API，将返回的 entries 转换为 FileNode 数组，
   * 更新对应节点的 children 和 loaded；同时更新 cwds[sessionId]。
   * 加载期间在 loading[sessionId] 中添加 path，完成后移除。
   */
  loadDir: (sessionId: string, path: string) => Promise<void>

  /**
   * 切换目录的展开/折叠状态。
   * 若 path 在 expanded[sessionId] 中则移除（折叠），否则添加（展开）。
   * 展开时若对应节点 loaded=false 则触发 loadDir。
   */
  toggleExpand: (sessionId: string, path: string) => void

  /**
   * 刷新指定会话的文件树。
   * 清空该会话的 trees、expanded、loading，重新加载根目录。
   */
  refresh: (sessionId: string) => void

  /**
   * 会话激活时调用，若该会话还没有 tree 则加载根目录。
   */
  initSession: (sessionId: string) => void
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 将 FileListResponse.entries 转换为 FileNode 数组。
 * 路径拼接规则：
 *   - 若 path 为 '.' 或 ''，子节点路径直接为 entry.name
 *   - 否则为 `${path}/${entry.name}`
 */
function entriesToNodes(response: FileListResponse): FileNode[] {
  const { path, entries } = response
  const isRoot = path === '.' || path === ''

  return entries.map((entry) => {
    const nodePath = isRoot ? entry.name : `${path}/${entry.name}`
    return {
      name: entry.name,
      path: nodePath,
      type: entry.type,
      loaded: entry.type === 'file',
      children: entry.type === 'dir' ? [] : undefined,
    }
  })
}

/**
 * 递归查找并更新指定路径节点的 children 和 loaded 状态。
 * 返回更新后的新节点（不可变更新）。
 */
function updateNodeChildren(
  node: FileNode,
  targetPath: string,
  children: FileNode[],
): FileNode {
  if (node.path === targetPath) {
    // 找到目标节点，更新 children 和 loaded
    return { ...node, children, loaded: true }
  }

  // 递归更新子节点
  if (node.children) {
    const updatedChildren = node.children.map((child) =>
      updateNodeChildren(child, targetPath, children),
    )
    return { ...node, children: updatedChildren }
  }

  return node
}

// ─── Store 实现 ────────────────────────────────────────────────────────────

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
  trees: new Map(),
  expanded: new Map(),
  loading: new Map(),
  cwds: new Map(),

  async loadDir(sessionId: string, path: string) {
    const state = get()

    // 标记为加载中
    const currentLoading = state.loading.get(sessionId) ?? new Set<string>()
    const newLoading = new Map(state.loading)
    newLoading.set(sessionId, new Set(currentLoading).add(path))
    set({ loading: newLoading })

    try {
      const response = await listFiles(sessionId, path)
      const children = entriesToNodes(response)

      set((s) => {
        const newTrees = new Map(s.trees)
        const newCwds = new Map(s.cwds)

        // 更新 cwd
        newCwds.set(sessionId, response.cwd)

        // 更新文件树
        const existingRoot = s.trees.get(sessionId)

        if (path === '.' || path === '') {
          // 根节点：直接创建或替换
          const rootNode: FileNode = {
            name: '.',
            path: '.',
            type: 'dir',
            children,
            loaded: true,
          }
          newTrees.set(sessionId, rootNode)
        } else if (existingRoot) {
          // 非根节点：递归更新对应节点
          const updatedRoot = updateNodeChildren(existingRoot, path, children)
          newTrees.set(sessionId, updatedRoot)
        }

        // 从 loading 中移除该路径
        const sessionLoading = s.loading.get(sessionId) ?? new Set<string>()
        const updatedLoading = new Map(s.loading)
        const newSessionLoading = new Set(sessionLoading)
        newSessionLoading.delete(path)
        updatedLoading.set(sessionId, newSessionLoading)

        return {
          trees: newTrees,
          cwds: newCwds,
          loading: updatedLoading,
        }
      })
    } catch (err) {
      console.error(`[fileTreeStore] loadDir 失败 (session=${sessionId}, path=${path}):`, err)

      // 加载失败时也要从 loading 中移除
      set((s) => {
        const sessionLoading = s.loading.get(sessionId) ?? new Set<string>()
        const updatedLoading = new Map(s.loading)
        const newSessionLoading = new Set(sessionLoading)
        newSessionLoading.delete(path)
        updatedLoading.set(sessionId, newSessionLoading)
        return { loading: updatedLoading }
      })
    }
  },

  toggleExpand(sessionId: string, path: string) {
    const state = get()
    const sessionExpanded = state.expanded.get(sessionId) ?? new Set<string>()
    const newExpanded = new Map(state.expanded)

    if (sessionExpanded.has(path)) {
      // 已展开 → 折叠
      const updated = new Set(sessionExpanded)
      updated.delete(path)
      newExpanded.set(sessionId, updated)
      set({ expanded: newExpanded })
    } else {
      // 未展开 → 展开
      const updated = new Set(sessionExpanded)
      updated.add(path)
      newExpanded.set(sessionId, updated)
      set({ expanded: newExpanded })

      // 若对应节点 loaded=false，触发懒加载
      const root = state.trees.get(sessionId)
      if (root) {
        const node = findNode(root, path)
        if (node && !node.loaded) {
          get().loadDir(sessionId, path)
        }
      }
    }
  },

  refresh(sessionId: string) {
    // 清空该会话的所有状态
    set((s) => {
      const newTrees = new Map(s.trees)
      const newExpanded = new Map(s.expanded)
      const newLoading = new Map(s.loading)

      newTrees.delete(sessionId)
      newExpanded.delete(sessionId)
      newLoading.delete(sessionId)

      return {
        trees: newTrees,
        expanded: newExpanded,
        loading: newLoading,
      }
    })

    // 重新加载根目录
    get().loadDir(sessionId, '.')
  },

  initSession(sessionId: string) {
    const { trees } = get()
    // 若该会话还没有 tree，则加载根目录
    if (!trees.has(sessionId)) {
      get().loadDir(sessionId, '.')
    }
  },
}))

// ─── 模块级辅助函数 ────────────────────────────────────────────────────────

/**
 * 在文件树中递归查找指定路径的节点。
 * 找不到时返回 undefined。
 */
function findNode(node: FileNode, targetPath: string): FileNode | undefined {
  if (node.path === targetPath) {
    return node
  }
  if (node.children) {
    for (const child of node.children) {
      const found = findNode(child, targetPath)
      if (found) return found
    }
  }
  return undefined
}
