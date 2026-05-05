/**
 * DsmlParser.ts — DeepSeek Markup Language 工具调用解析器
 *
 * DSML 是 DeepSeek 模型在不走标准 function calling 时，以文本形式输出工具调用的私有格式。
 *
 * ── 格式规范 ──────────────────────────────────────────────────────────────────
 *
 * 外层包装（可选）：
 *   <|DSML|tool_calls> ... </|DSML|tool_calls>
 *
 * 带参数的工具调用：
 *   <|DSML|invoke name="tool_name">
 *     <|DSML|parameter name="param1"><![CDATA[value1]]></|DSML|parameter>
 *     <|DSML|parameter name="param2">plain_value</|DSML|parameter>
 *   </|DSML|invoke>
 *
 * 无参数的工具调用（自闭合）：
 *   <|DSML|invoke name="tool_name"/>
 *
 * ── 已知问题与修复 ────────────────────────────────────────────────────────────
 *
 * 问题：当 CDATA 内容为 JSON 数组时，末尾是 `]]]>`（JSON 的 `]` + CDATA 结束 `]]>`）。
 *       正则非贪婪匹配会在第一个 `]]>` 处停止，导致 JSON 数组末尾的 `]` 被截断。
 *
 * 根因：`invokeRegex` 使用 `([\s\S]*?)<\/\|DSML\|invoke>` 非贪婪匹配 invoke body，
 *       当 body 内含 `]]>` 时，`>` 字符会被误认为 `</|DSML|invoke>` 的一部分而提前截断。
 *       实际上是 `paramRegex` 的非贪婪匹配 `([\s\S]*?)<\/\|DSML\|parameter>` 在
 *       `]]></|DSML|parameter>` 中，遇到 `]]]>` 时，`[\s\S]*?` 停在 `]]>` 处，
 *       把 JSON 数组的最后一个 `]` 留在了 CDATA 结束标记里。
 *
 * 修复：改用字符级状态机解析器，完全避免正则在嵌套结构上的歧义。
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface DsmlToolCall {
  /** 唯一 ID，格式 dsml_<counter>_<timestamp> */
  id: string
  /** 工具名称 */
  name: string
  /** 解析后的参数对象 */
  input: Record<string, unknown>
}

export interface DsmlParseResult {
  /** 解析出的工具调用列表 */
  toolCalls: DsmlToolCall[]
  /** 去除 DSML 块后的纯文本（用于展示给用户） */
  cleanText: string
  /** 是否包含 DSML 标记 */
  hasDsml: boolean
}

// ── 内部计数器 ────────────────────────────────────────────────────────────────

let _counter = 0

function nextId(): string {
  return `dsml_${++_counter}_${Date.now()}`
}

// ── 核心解析器 ────────────────────────────────────────────────────────────────

/**
 * 从文本中提取所有 DSML 工具调用。
 *
 * 采用字符级状态机而非正则，彻底解决 CDATA 内容含 `]]>` 时的截断问题。
 */
export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  const results: DsmlToolCall[] = []

  let pos = 0
  while (pos < text.length) {
    // 查找下一个 <|DSML|invoke
    const invokeStart = text.indexOf('<|DSML|invoke', pos)
    if (invokeStart === -1) break

    // 找到标签的 > 结束位置（限制在当前标签内搜索 name 属性）
    const tagEnd = text.indexOf('>', invokeStart)
    if (tagEnd === -1) { pos = invokeStart + 1; continue }

    // 提取完整的开始标签内容，在其中查找 name 属性
    // 限制范围：invokeStart 到 tagEnd，避免跨标签污染
    const openTag = text.slice(invokeStart, tagEnd + 1)
    const nameMatch = openTag.match(/name="([^"]*)"/)
    if (!nameMatch) { pos = tagEnd + 1; continue }

    const toolName = nameMatch[1]

    // 判断是自闭合还是普通标签
    const isSelfClosing = openTag.trimEnd().endsWith('/>')

    if (isSelfClosing) {
      // 无参数工具调用
      results.push({ id: nextId(), name: toolName, input: {} })
      pos = tagEnd + 1
      continue
    }

    // 普通标签：找到对应的 </|DSML|invoke>
    // 使用字符级扫描，正确处理 CDATA 内容
    const bodyStart = tagEnd + 1
    const bodyEnd = findInvokeBodyEnd(text, bodyStart)
    if (bodyEnd === -1) { pos = invokeStart + 1; continue }

    const invokeBody = text.slice(bodyStart, bodyEnd)
    const params = parseParameters(invokeBody)

    results.push({ id: nextId(), name: toolName, input: params })
    pos = bodyEnd + '</|DSML|invoke>'.length
  }

  return results
}

/**
 * 从 invoke body 中解析所有参数。
 * 同样使用字符级扫描，正确处理 CDATA 内容中的特殊字符。
 *
 * 自动修复：LLM 有时把整个工具参数对象塞进单个 parameter，例如：
 *   <parameter name="todos"><![CDATA[{"todos":[...]}]]></parameter>
 * 解析后得到 { todos: { todos: [...] } }，需要 unwrap 成 { todos: [...] }。
 * 检测条件：params 只有一个键，且该键的值是一个对象，且该对象也只有同名键。
 */
function parseParameters(body: string): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  let pos = 0

  while (pos < body.length) {
    // 查找 <|DSML|parameter
    const paramStart = body.indexOf('<|DSML|parameter', pos)
    if (paramStart === -1) break

    // 找到标签的 > 结束位置，在其中查找 name 属性（限制范围，避免跨标签污染）
    const tagEnd = body.indexOf('>', paramStart)
    if (tagEnd === -1) { pos = paramStart + 1; continue }

    const openTag = body.slice(paramStart, tagEnd + 1)
    const nameMatch = openTag.match(/name="([^"]*)"/)
    if (!nameMatch) { pos = tagEnd + 1; continue }

    const paramName = nameMatch[1]
    const valueStart = tagEnd + 1

    // 找到对应的 </|DSML|parameter>，正确跳过 CDATA 内容
    const valueEnd = findParamValueEnd(body, valueStart)
    if (valueEnd === -1) { pos = paramStart + 1; continue }

    const rawValue = body.slice(valueStart, valueEnd)
    params[paramName] = parseParamValue(rawValue)

    pos = valueEnd + '</|DSML|parameter>'.length
  }

  // 自动修复：检测 LLM 把整个参数对象包在单个 parameter 里的情况
  // 例：{ todos: { todos: [...] } } → { todos: [...] }
  const keys = Object.keys(params)
  if (keys.length === 1) {
    const key = keys[0]!
    const val = params[key]
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val)
    ) {
      const innerKeys = Object.keys(val as object)
      // 内层对象的键是外层参数名的超集（LLM 把整个工具 input 对象塞进来了）
      if (innerKeys.includes(key)) {
        // unwrap：用内层对象替换外层 params
        return val as Record<string, unknown>
      }
    }
  }

  return params
}

/**
 * 从 bodyStart 开始，找到 </|DSML|invoke> 的起始位置。
 * 正确跳过 CDATA 块（CDATA 内容不参与标签匹配）。
 */
function findInvokeBodyEnd(text: string, bodyStart: number): number {
  const closeTag = '</|DSML|invoke>'
  let pos = bodyStart

  while (pos < text.length) {
    // 检查是否进入 CDATA
    if (text.startsWith('<![CDATA[', pos)) {
      // 跳过整个 CDATA 块
      const cdataEnd = findCdataEnd(text, pos + 9)
      if (cdataEnd === -1) return -1
      pos = cdataEnd + 3  // 跳过 ]]>
      continue
    }

    // 检查是否到达 </|DSML|invoke>
    if (text.startsWith(closeTag, pos)) {
      return pos
    }

    pos++
  }

  return -1
}

/**
 * 从 valueStart 开始，找到 </|DSML|parameter> 的起始位置。
 * 正确跳过 CDATA 块。
 */
function findParamValueEnd(text: string, valueStart: number): number {
  const closeTag = '</|DSML|parameter>'
  let pos = valueStart

  while (pos < text.length) {
    // 检查是否进入 CDATA
    if (text.startsWith('<![CDATA[', pos)) {
      const cdataEnd = findCdataEnd(text, pos + 9)
      if (cdataEnd === -1) return -1
      pos = cdataEnd + 3  // 跳过 ]]>
      continue
    }

    // 检查是否到达 </|DSML|parameter>
    if (text.startsWith(closeTag, pos)) {
      return pos
    }

    pos++
  }

  return -1
}

/**
 * 从 CDATA 内容起始位置（`<![CDATA[` 之后）找到 `]]>` 的位置。
 * 返回 `]]>` 中第一个 `]` 的索引。
 */
function findCdataEnd(text: string, contentStart: number): number {
  let pos = contentStart
  while (pos < text.length - 2) {
    if (text[pos] === ']' && text[pos + 1] === ']' && text[pos + 2] === '>') {
      return pos
    }
    pos++
  }
  return -1
}

/**
 * 解析单个参数值：
 * 1. 如果是 CDATA 包装，提取内容后尝试 JSON.parse
 * 2. 如果内容是嵌套的 <|DSML|parameter> 块（LLM 用 XML 方式表达数组/对象），
 *    递归解析成数组或对象
 * 3. 尝试 JSON.parse 原始字符串
 * 4. 失败则返回 trim 后的字符串
 *
 * 特殊处理：LLM 有时会把整个工具参数对象作为单个参数值传入，
 * 例如 parameter name="todos" 的值是 {"todos":[...]} 而非直接的 [...]。
 * 此时解析后会得到 { todos: { todos: [...] } }，在 parseParameters 的
 * 自动修复逻辑中统一处理（unwrap 外层同名包装）。
 */
function parseParamValue(raw: string): unknown {
  let value = raw

  // 提取 CDATA 内容
  const cdataOpen = value.indexOf('<![CDATA[')
  if (cdataOpen !== -1) {
    const contentStart = cdataOpen + 9  // 跳过 <![CDATA[
    const cdataEnd = findCdataEnd(value, contentStart)
    if (cdataEnd !== -1) {
      value = value.slice(contentStart, cdataEnd)
    }
    // 如果找不到 ]]>，保留原始值继续尝试解析
  } else {
    value = value.trim()
  }

  // 检测嵌套 DSML parameter 格式（LLM 用 XML 方式表达数组）
  // 例：<|DSML|parameter name="item">...</|DSML|parameter> × N
  // 转换为数组：[{content:..., priority:...}, ...]
  if (value.includes('<|DSML|parameter')) {
    return parseNestedParameters(value)
  }

  // 尝试 JSON 解析
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * 将嵌套的 DSML parameter 块解析为数组或对象。
 *
 * LLM 有时用嵌套 parameter 表达数组，例如：
 *   <|DSML|parameter name="item">{fields}</|DSML|parameter>
 *   <|DSML|parameter name="item">{fields}</|DSML|parameter>
 * → [{...}, {...}]（同名 item 重复 → 数组）
 *
 * 或用嵌套 parameter 表达对象：
 *   <|DSML|parameter name="content">...</|DSML|parameter>
 *   <|DSML|parameter name="priority">...</|DSML|parameter>
 * → { content: ..., priority: ... }（不同名 → 对象）
 */
function parseNestedParameters(body: string): unknown {
  // 收集所有同级 parameter，记录 name 和解析后的值
  const entries: Array<{ name: string; value: unknown }> = []
  let pos = 0

  while (pos < body.length) {
    const paramStart = body.indexOf('<|DSML|parameter', pos)
    if (paramStart === -1) break

    const tagEnd = body.indexOf('>', paramStart)
    if (tagEnd === -1) { pos = paramStart + 1; continue }

    const openTag = body.slice(paramStart, tagEnd + 1)
    const nameMatch = openTag.match(/name="([^"]*)"/)
    if (!nameMatch) { pos = tagEnd + 1; continue }

    const paramName = nameMatch[1]!
    const valueStart = tagEnd + 1
    const valueEnd = findParamValueEnd(body, valueStart)
    if (valueEnd === -1) { pos = paramStart + 1; continue }

    const rawValue = body.slice(valueStart, valueEnd)
    entries.push({ name: paramName, value: parseParamValue(rawValue) })

    pos = valueEnd + '</|DSML|parameter>'.length
  }

  if (entries.length === 0) return body.trim()

  // 判断是数组还是对象：同名 key 出现多次 → 数组
  const nameCount = new Map<string, number>()
  for (const e of entries) {
    nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1)
  }
  const hasRepeatedNames = [...nameCount.values()].some(c => c > 1)

  if (hasRepeatedNames) {
    // 同名重复 → 每个 entry 的 value 作为数组元素
    return entries.map(e => e.value)
  } else {
    // 不同名 → 合并为对象
    const obj: Record<string, unknown> = {}
    for (const e of entries) {
      obj[e.name] = e.value
    }
    return obj
  }
}

// ── 文本清理 ──────────────────────────────────────────────────────────────────

/**
 * 从文本中移除所有 DSML 块，返回清理后的纯文本。
 *
 * 处理顺序：
 * 1. 移除 <|DSML|tool_calls>...</|DSML|tool_calls> 整块
 * 2. 移除残留的自闭合 invoke 标签
 * 3. 移除残留的普通 invoke 块（含 CDATA，用字符级扫描）
 */
export function stripDsmlBlocks(text: string): string {
  let result = text

  // 1. 移除外层 tool_calls 包装（含内部所有内容）
  result = removeTagBlocks(result, '<|DSML|tool_calls>', '</|DSML|tool_calls>')

  // 2. 移除残留的自闭合 invoke 标签
  result = result.replace(/<\|DSML\|invoke\s+name="[^"]+"\s*\/>/g, '')

  // 3. 移除残留的普通 invoke 块（字符级扫描，正确处理 CDATA）
  result = removeInvokeBlocks(result)

  return result.trim()
}

/**
 * 移除所有 openTag...closeTag 块（不含嵌套，CDATA 安全）。
 */
function removeTagBlocks(text: string, openTag: string, closeTag: string): string {
  let result = ''
  let pos = 0

  while (pos < text.length) {
    const start = text.indexOf(openTag, pos)
    if (start === -1) {
      result += text.slice(pos)
      break
    }

    result += text.slice(pos, start)

    // 找到对应的 closeTag，跳过 CDATA
    let scanPos = start + openTag.length
    let found = false

    while (scanPos < text.length) {
      if (text.startsWith('<![CDATA[', scanPos)) {
        const cdataEnd = findCdataEnd(text, scanPos + 9)
        if (cdataEnd === -1) { scanPos = text.length; break }
        scanPos = cdataEnd + 3
        continue
      }
      if (text.startsWith(closeTag, scanPos)) {
        pos = scanPos + closeTag.length
        found = true
        break
      }
      scanPos++
    }

    if (!found) {
      // 没找到关闭标签，保留剩余文本
      result += text.slice(start)
      break
    }
  }

  return result
}

/**
 * 移除所有 <|DSML|invoke ...>...</|DSML|invoke> 块（字符级，CDATA 安全）。
 */
function removeInvokeBlocks(text: string): string {
  let result = ''
  let pos = 0

  while (pos < text.length) {
    const invokeStart = text.indexOf('<|DSML|invoke', pos)
    if (invokeStart === -1) {
      result += text.slice(pos)
      break
    }

    // 找到 > 确定标签结束
    const tagEnd = text.indexOf('>', invokeStart)
    if (tagEnd === -1) {
      result += text.slice(pos)
      break
    }

    // 自闭合标签已在上层用正则处理，这里只处理普通标签
    const tagContent = text.slice(invokeStart, tagEnd + 1)
    if (tagContent.endsWith('/>')) {
      result += text.slice(pos, invokeStart)
      pos = tagEnd + 1
      continue
    }

    result += text.slice(pos, invokeStart)

    // 找到 </|DSML|invoke>
    const bodyStart = tagEnd + 1
    const bodyEnd = findInvokeBodyEnd(text, bodyStart)
    if (bodyEnd === -1) {
      // 没找到关闭标签，跳过这个 invoke 开始标签
      pos = tagEnd + 1
      continue
    }

    pos = bodyEnd + '</|DSML|invoke>'.length
  }

  return result
}

// ── 提供商检测 ────────────────────────────────────────────────────────────────

/**
 * 快速检测文本是否包含 DSML 工具调用标记（用于决定是否触发解析）。
 * 使用 `<|DSML|invoke` 而非 `<|DSML|`，避免模型在讨论 DSML 格式时
 * 因回复中出现 <|DSML| 字符串而误触发解析。
 * 不依赖提供商名称，直接检测输出内容，兼容任何输出 DSML 格式的模型。
 */
export function hasDsmlMarker(text: string): boolean {
  return text.includes('<|DSML|invoke')
}

// ── 一体化解析入口 ────────────────────────────────────────────────────────────

/**
 * 解析文本中的 DSML 工具调用，同时返回清理后的纯文本。
 *
 * @param text - LLM 输出的原始文本
 * @returns DsmlParseResult
 */
export function parseDsml(text: string): DsmlParseResult {
  const hasDsml = hasDsmlMarker(text)

  if (!hasDsml) {
    return { toolCalls: [], cleanText: text, hasDsml: false }
  }

  const toolCalls = parseDsmlToolCalls(text)
  const cleanText = toolCalls.length > 0 ? stripDsmlBlocks(text) : text

  return { toolCalls, cleanText, hasDsml: true }
}
