// 记忆系统类型定义

// 记忆类型
export type MemoryType =
  | 'decision'    // 决策：选择了 X 因为 Y
  | 'preference'  // 偏好：总是/从不使用 X
  | 'milestone'   // 里程碑：终于完成了 X
  | 'problem'     // 问题：X 出错了，解决方案是 Y
  | 'fact'        // 事实：通用知识点

// 单条记忆
export interface Memory {
  id: string
  content: string           // 原始内容
  type: MemoryType
  agent: string             // 所属智能体（如 main）
  importance: number        // 1-5
  createdAt: string         // ISO 日期
  updatedAt: string         // ISO 日期
  sourceSession?: string    // 来源会话 ID
  supersededBy?: string     // 被哪条记忆取代（非空则为已失效）
}

// 知识图谱三元组
export interface Triple {
  id: string
  subject: string
  predicate: string
  object: string
  validFrom?: string
  validTo?: string          // null = 当前有效
  confidence: number        // 0-1
  sourceMemoryId?: string
  createdAt: string
}

// 唤醒结果
export interface WakeUpResult {
  summary: string           // 记忆摘要
  totalTokens: number
}

// 记忆搜索结果
export interface MemorySearchResult {
  memory: Memory
  score: number             // 相似度 0-1
}
