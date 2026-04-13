// 记忆系统类型定义 —— 借鉴 mempalace 的宫殿记忆法

// 记忆类型（对应 mempalace 的 5 种提取类型）
export type MemoryType =
  | 'decision'    // 决策：选择了 X 因为 Y
  | 'preference'  // 偏好：总是/从不使用 X
  | 'milestone'   // 里程碑：终于完成了 X
  | 'problem'     // 问题：X 出错了，解决方案是 Y
  | 'emotional'   // 情感：感受、关系
  | 'fact'        // 事实：通用知识点

// 单条记忆（对应 mempalace 的 drawer）
export interface Memory {
  id: string
  content: string           // 原始逐字内容
  type: MemoryType
  wing: string              // 所属翼（项目/人物）
  room: string              // 所属房间（主题）
  tags: string[]
  importance: number        // 1-5
  createdAt: string         // ISO 日期
  sourceSession?: string    // 来源会话 ID
  embedding?: number[]      // TF-IDF 向量（可选）
}

// 知识图谱三元组（对应 mempalace 的 KnowledgeGraph）
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

// 4 层记忆堆栈的唤醒结果
export interface WakeUpResult {
  l0Identity: string        // ~100 tokens：身份定义
  l1Essential: string       // ~500-800 tokens：核心记忆摘要
  totalTokens: number
}

// 记忆搜索结果
export interface MemorySearchResult {
  memory: Memory
  score: number             // 相似度 0-1
}
