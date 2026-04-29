// DSML 解析器测试
// 从 QueryEngine.ts 中提取的解析逻辑

let _dsmlCallCounter = 0

function parseDsmlToolCalls(text) {
  const results = []

  // 同时匹配自闭合标签（无参数）和普通标签（有参数）
  const invokeRegex = /<\|DSML\|invoke\s+name="([^"]+)"(?:\s*\/>|([\s\S]*?)<\/\|DSML\|invoke>)/g
  let invokeMatch

  while ((invokeMatch = invokeRegex.exec(text)) !== null) {
    const toolName = invokeMatch[1]
    const invokeBody = invokeMatch[2] ?? ''
    const params = {}

    const paramRegex = /<\|DSML\|parameter\s+name="([^"]+)">([\s\S]*?)<\/\|DSML\|parameter>/g
    let paramMatch

    while ((paramMatch = paramRegex.exec(invokeBody)) !== null) {
      const paramName = paramMatch[1]
      let paramValue = paramMatch[2]

      // 去除 CDATA 包装
      const cdataMatch = paramValue.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
      if (cdataMatch) {
        paramValue = cdataMatch[1]
      } else {
        paramValue = paramValue.trim()
      }

      // 尝试 JSON 解析
      try {
        params[paramName] = JSON.parse(paramValue)
      } catch {
        params[paramName] = paramValue
      }
    }

    results.push({
      id: `dsml_${++_dsmlCallCounter}_${Date.now()}`,
      name: toolName,
      input: params,
    })
  }

  return results
}

function stripDsmlBlocks(text) {
  let result = text.replace(/<\|DSML\|tool_calls>[\s\S]*?<\/\|DSML\|tool_calls>/g, '')
  result = result.replace(/<\|DSML\|invoke\s+name="[^"]+"\s*\/>/g, '')
  result = result.replace(/<\|DSML\|invoke\s+name="[^"]+">([\s\S]*?)<\/\|DSML\|invoke>/g, '')
  return result.trim()
}

// 测试用例
console.log('=== 测试1: 带参数的工具调用（CDATA 包含 JSON 数组）===')
const test1 = `<|DSML|tool_calls>   <|DSML|invoke name="todo_write">     <|DSML|parameter name="todos"><![CDATA[[{"id": "1", "content": "探索并发现所有可用的 API 端点（通过登录后的前端调用）", "status": "pending", "priority": "high"}, {"id": "2", "content": "编写完整测试脚本 full_test.py：登录、认证、会话、待办事项、消息等 API 测试", "status": "pending", "priority": "high"}]]]></|DSML|parameter>   </|DSML|invoke> </|DSML|tool_calls>`
const result1 = parseDsmlToolCalls(test1)
console.log('解析结果:', JSON.stringify(result1, null, 2))
console.log('清理后文本:', stripDsmlBlocks(test1))

console.log('\n=== 测试2: 无参数的工具调用（自闭合标签）===')
const test2 = `<|DSML|tool_calls> <|DSML|invoke name="todo_read"/> </|DSML|tool_calls>`
const result2 = parseDsmlToolCalls(test2)
console.log('解析结果:', JSON.stringify(result2, null, 2))
console.log('清理后文本:', stripDsmlBlocks(test2))

console.log('\n=== 测试3: 混合文本和工具调用 ===')
const test3 = `好的，我来更新任务列表。

<|DSML|tool_calls>
  <|DSML|invoke name="todo_write">
    <|DSML|parameter name="todos"><![CDATA[
[
  {"id": "1", "content": "任务1", "status": "pending", "priority": "high"},
  {"id": "2", "content": "任务2", "status": "in_progress", "priority": "medium"}
]
    ]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`
const result3 = parseDsmlToolCalls(test3)
console.log('解析结果:', JSON.stringify(result3, null, 2))
console.log('清理后文本:', stripDsmlBlocks(test3))

console.log('\n=== 测试4: 多个工具调用 ===')
const test4 = `<|DSML|tool_calls>
  <|DSML|invoke name="todo_write">
    <|DSML|parameter name="todos"><![CDATA[[{"id":"1","content":"test","status":"pending","priority":"high"}]]]></|DSML|parameter>
  </|DSML|invoke>
  <|DSML|invoke name="todo_read"/>
</|DSML|tool_calls>`
const result4 = parseDsmlToolCalls(test4)
console.log('解析结果:', JSON.stringify(result4, null, 2))
console.log('清理后文本:', stripDsmlBlocks(test4))
