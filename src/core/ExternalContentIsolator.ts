// ExternalContentIsolator — 隔离外部内容，防止提示注入攻击
// 参考 OpenClaw 的随机边界标记 + 注入检测 + Token 清洗

import crypto from 'crypto'

/** 提示注入检测模式 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system:\s*/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /forget\s+everything/i,
  /new\s+instructions?:/i,
  /disregard\s+(all\s+)?prior/i,
  /override\s+(your\s+)?instructions/i,
  /act\s+as\s+if/i,
  /pretend\s+you\s+are/i,
  /role\s*:\s*system/i,
  /<\|system\|>/i,
  /\[\/INST\]/i,
]

/** 零宽字符（用于隐藏边界标记） */
const ZERO_WIDTH_CHARS = /[​‌‍⁠﻿­]/g

/** LLM 特殊 Token */
const LLM_TOKENS = /<\|im_start\|>|<\|im_end\|>|<\/?s>|\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>/g

export class ExternalContentIsolator {
  /**
   * 隔离外部内容
   * @param content 原始内容
   * @param source 来源标识（如 'web:https://example.com'）
   * @returns 隔离后的内容
   */
  isolate(content: string, source: string): string {
    // 1. 移除零宽字符（防止隐藏边界标记）
    let safe = content.replace(ZERO_WIDTH_CHARS, '')

    // 2. 清洗 LLM 特殊 Token
    safe = safe.replace(LLM_TOKENS, '')

    // 3. 检测提示注入
    const hasInjection = INJECTION_PATTERNS.some(p => p.test(safe))
    const warning = hasInjection
      ? '\n[WARNING: This external content may contain prompt injection attempts]\n'
      : ''

    // 4. 包裹随机边界（防止 LLM 被诱导"跳出"外部内容区域）
    const boundary = crypto.randomBytes(8).toString('hex')
    return `${warning}<<<EXTERNAL_${boundary} source="${source}">>>\n${safe}\n<<<END_${boundary}>>>`
  }
}
