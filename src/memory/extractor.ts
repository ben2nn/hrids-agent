// 记忆提取器 —— 从对话文本中识别 5 种记忆类型
// 借鉴 mempalace 的 general_extractor.py，用纯正则实现，无需 LLM
import type { MemoryType } from './types.js'

// ── 各类型的关键词模式 ────────────────────────────────────────

const DECISION_PATTERNS = [
  /\b(让我们|我们|我)(使用|选择|采用|切换到|决定用)\b/,
  /\b(应该|决定|选择了|采用了|用了)\b/,
  /\b(而不是|替代|代替)\b/,
  /\b(因为|原因是|所以选)\b/,
  /\b(架构|方案|策略|框架|技术栈)\b/,
  /\blet'?s (use|go with|try|pick|choose|switch to)\b/i,
  /\bwe (decided|chose|went with|picked|settled on)\b/i,
  /\binstead of\b/i,
  /\bbecause\b/i,
  /\btrade-?off\b/i,
]

const PREFERENCE_PATTERNS = [
  /\b(我喜欢|我偏好|我倾向于)\b/,
  /\b(总是|永远|从不|绝不)(使用|用|做)\b/,
  /\b(不要|不能|禁止)(使用|用)\b/,
  /\b(规范|约定|风格|习惯)是\b/,
  /\bi prefer\b/i,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bdon'?t (use|do)\b/i,
  /\bmy (rule|preference|style|convention) is\b/i,
]

const MILESTONE_PATTERNS = [
  /\b(终于|成功|完成了|实现了|搞定了)\b/,
  /\b(第一次|首次|突破)\b/,
  /\b(发现了|找到了|明白了|理解了)\b/,
  /\b(上线了|发布了|部署了)\b/,
  /\bit works?\b/i,
  /\bgot it working\b/i,
  /\bfixed\b/i,
  /\bfinally\b/i,
  /\bbreakthrough\b/i,
  /\bfigured (it )?out\b/i,
  /\bshipped\b/i,
]

const PROBLEM_PATTERNS = [
  /\b(bug|错误|崩溃|失败|问题|故障)\b/,
  /\b(不工作|不起作用|出错了)\b/,
  /\b(根本原因|根因|原因是)\b/,
  /\b(解决方案|修复方法|解决了)\b/,
  /\b(bug|error|crash|fail|broke|broken|issue|problem)\b/i,
  /\bdoesn'?t work\b/i,
  /\broot cause\b/i,
  /\bworkaround\b/i,
  /\bthe fix (is|was)\b/i,
]

const EMOTIONAL_PATTERNS = [
  /\b(喜欢|爱|害怕|担心|高兴|难过|感谢|抱歉)\b/,
  /\b(感觉|感受|情绪)\b/,
  /\bi (love|hate|feel|miss|need|wish)\b/i,
  /\b(scared|afraid|proud|happy|sad|grateful|angry|worried|lonely)\b/i,
  /\*[^*]+\*/,  // *情感标记*
]

const ALL_PATTERNS: Record<MemoryType, RegExp[]> = {
  decision: DECISION_PATTERNS,
  preference: PREFERENCE_PATTERNS,
  milestone: MILESTONE_PATTERNS,
  problem: PROBLEM_PATTERNS,
  emotional: EMOTIONAL_PATTERNS,
  fact: [],
}

// 正向词（用于消歧）
const POSITIVE_WORDS = new Set([
  '成功', '完成', '实现', '突破', '发现', '解决',
  'works', 'fixed', 'solved', 'success', 'breakthrough', 'nailed',
])

// 负向词
const NEGATIVE_WORDS = new Set([
  'bug', 'error', 'crash', 'fail', 'broken', 'issue', 'problem',
  '错误', '崩溃', '失败', '问题', '故障',
])

function scoreText(text: string, patterns: RegExp[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const p of patterns) {
    const matches = lower.match(new RegExp(p.source, p.flags + (p.flags.includes('g') ? '' : 'g')))
    if (matches) score += matches.length
  }
  return score
}

function getSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const words = new Set(text.toLowerCase().split(/\W+/))
  const pos = [...words].filter(w => POSITIVE_WORDS.has(w)).length
  const neg = [...words].filter(w => NEGATIVE_WORDS.has(w)).length
  if (pos > neg) return 'positive'
  if (neg > pos) return 'negative'
  return 'neutral'
}

function hasResolution(text: string): boolean {
  return /\b(fixed|solved|resolved|got it working|it works|figured out|the fix)\b/i.test(text)
    || /\b(修复了|解决了|搞定了|终于工作了)\b/.test(text)
}

// 消歧：已解决的问题 → milestone
function disambiguate(type: MemoryType, text: string, scores: Record<string, number>): MemoryType {
  const sentiment = getSentiment(text)
  if (type === 'problem' && hasResolution(text)) {
    if ((scores.emotional ?? 0) > 0 && sentiment === 'positive') return 'emotional'
    return 'milestone'
  }
  if (type === 'problem' && sentiment === 'positive') {
    if ((scores.milestone ?? 0) > 0) return 'milestone'
    if ((scores.emotional ?? 0) > 0) return 'emotional'
  }
  return type
}

// 类型基础分
const TYPE_BASE_SCORE: Record<MemoryType, number> = {
  decision: 4,
  milestone: 4,
  problem: 3,
  preference: 3,
  fact: 2,
  emotional: 2,
}

// 动态重要性评分（1-5）
function calcImportance(type: MemoryType, text: string, confidence: number): number {
  let score = TYPE_BASE_SCORE[type]
  // 内容越详细越重要
  if (text.length > 200) score += 0.5
  // 包含具体版本号、数字、技术名称
  if (/v\d+\.\d+|\d{4}|[A-Z][a-z]+[A-Z]/.test(text)) score += 0.5
  // 高置信度加分
  if (confidence >= 0.7) score += 0.5
  return Math.min(5, Math.round(score))
}

export interface ExtractedMemory {
  content: string
  type: MemoryType
  confidence: number  // 0-1
  importance: number  // 1-5，动态评分
}

/**
 * 从文本中提取记忆片段，识别类型和置信度
 * 纯启发式，无需 LLM
 */
export function extractMemories(text: string, minConfidence = 0.3): ExtractedMemory[] {
  const segments = splitIntoSegments(text)
  const results: ExtractedMemory[] = []

  for (const seg of segments) {
    if (seg.trim().length < 20) continue

    const scores: Record<string, number> = {}
    for (const [type, patterns] of Object.entries(ALL_PATTERNS)) {
      if (patterns.length === 0) continue
      const s = scoreText(seg, patterns)
      if (s > 0) scores[type] = s
    }

    if (Object.keys(scores).length === 0) continue

    // 长度加成
    const lengthBonus = seg.length > 500 ? 2 : seg.length > 200 ? 1 : 0

    let bestType = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0] as MemoryType
    const bestScore = scores[bestType] + lengthBonus

    bestType = disambiguate(bestType, seg, scores)

    const confidence = Math.min(1.0, bestScore / 5.0)
    if (confidence < minConfidence) continue

    const importance = calcImportance(bestType, seg, confidence)
    results.push({ content: seg.trim(), type: bestType, confidence, importance })
  }

  return results
}

function splitIntoSegments(text: string): string[] {
  const lines = text.split('\n')

  // 检测对话轮次标记
  const turnPatterns = [
    /^>\s/,
    /^(Human|User|Q)\s*:/i,
    /^(Assistant|AI|Claude)\s*:/i,
    /^用户[:：]/,
    /^助手[:：]/,
  ]

  let turnCount = 0
  for (const line of lines) {
    if (turnPatterns.some(p => p.test(line.trim()))) turnCount++
  }

  if (turnCount >= 3) {
    return splitByTurns(lines, turnPatterns)
  }

  // 按段落分割
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  if (paragraphs.length > 1) return paragraphs

  // 单块大文本：按 25 行分组
  if (lines.length > 20) {
    const segments: string[] = []
    for (let i = 0; i < lines.length; i += 25) {
      const group = lines.slice(i, i + 25).join('\n').trim()
      if (group) segments.push(group)
    }
    return segments
  }

  return [text]
}

function splitByTurns(lines: string[], patterns: RegExp[]): string[] {
  const segments: string[] = []
  let current: string[] = []

  for (const line of lines) {
    const isTurn = patterns.some(p => p.test(line.trim()))
    if (isTurn && current.length > 0) {
      segments.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) segments.push(current.join('\n'))
  return segments
}

/**
 * 从对话历史中自动提取记忆（供 QueryEngine 在会话结束后调用）
 * 同时扫描 user 和 assistant 消息：
 * - user 消息包含偏好、决策意图（"以后都用X"）
 * - assistant 消息包含里程碑、问题解决方案
 */
export function extractFromConversation(
  messages: Array<{ role: string; content: string | unknown[] }>
): ExtractedMemory[] {
  const extractText = (m: { role: string; content: string | unknown[] }): string => {
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
    }
    return ''
  }

  // user 消息：重点提取 preference / decision / fact
  const userTexts = messages
    .filter(m => m.role === 'user')
    .map(extractText)
    .filter(Boolean)

  // assistant 消息：重点提取 milestone / problem / decision
  const assistantTexts = messages
    .filter(m => m.role === 'assistant')
    .map(extractText)
    .filter(Boolean)

  const allText = [...userTexts, ...assistantTexts].join('\n\n')
  return extractMemories(allText)
}
