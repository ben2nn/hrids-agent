/**
 * DsmlParser.test.ts — DSML 解析器完整测试套件
 */

import { describe, it, expect } from 'vitest'
import {
  parseDsml,
  parseDsmlToolCalls,
  stripDsmlBlocks,
  hasDsmlMarker,
} from './DsmlParser.js'

describe('DsmlParser', () => {
  describe('hasDsmlMarker', () => {
    it('应检测 DSML invoke 标记', () => {
      expect(hasDsmlMarker('hello <|DSML|invoke name="test"/>')).toBe(true)
      expect(hasDsmlMarker('<|DSML|invoke name="foo">')).toBe(true)
      // <|DSML|tool_calls> 单独出现不触发（没有 invoke）
      expect(hasDsmlMarker('<|DSML|tool_calls>')).toBe(false)
      // 讨论 DSML 格式的普通文本不触发
      expect(hasDsmlMarker('这是 <|DSML| 格式的说明文档')).toBe(false)
      expect(hasDsmlMarker('plain text')).toBe(false)
    })
  })

  describe('parseDsmlToolCalls', () => {
    it('应解析无参数工具调用（自闭合）', () => {
      const text = '<|DSML|invoke name="todo_read"/>'
      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('todo_read')
      expect(calls[0].input).toEqual({})
      expect(calls[0].id).toMatch(/^dsml_\d+_\d+$/)
    })

    it('应解析带参数工具调用（无 CDATA）', () => {
      const text = `<|DSML|invoke name="file_read">
  <|DSML|parameter name="path">test.txt</|DSML|parameter>
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('file_read')
      expect(calls[0].input).toEqual({ path: 'test.txt' })
    })

    it('应解析 CDATA 包装的字符串参数', () => {
      const text = `<|DSML|invoke name="file_read">
  <|DSML|parameter name="path"><![CDATA[explore_login_page.py]]></|DSML|parameter>
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input).toEqual({ path: 'explore_login_page.py' })
    })

    it('应解析 CDATA 包装的 JSON 对象', () => {
      const text = `<|DSML|invoke name="todo_write">
  <|DSML|parameter name="todos"><![CDATA[{"id":"1","content":"test"}]]></|DSML|parameter>
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input).toEqual({
        todos: { id: '1', content: 'test' },
      })
    })

    it('应解析 CDATA 包装的 JSON 数组（关键测试：]]]> 问题）', () => {
      const text = `<|DSML|invoke name="todo_write">
  <|DSML|parameter name="todos"><![CDATA[[{"id":"1","content":"test"}]]]></|DSML|parameter>
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input.todos).toBeInstanceOf(Array)
      expect((calls[0].input.todos as unknown[]).length).toBe(1)
      expect(calls[0].input).toEqual({
        todos: [{ id: '1', content: 'test' }],
      })
    })

    it('应解析多对象 JSON 数组（]]]> 问题）', () => {
      const text = `<|DSML|invoke name="todo_write">
  <|DSML|parameter name="todos"><![CDATA[[
    {"id":"1","content":"任务1","status":"pending","priority":"high"},
    {"id":"2","content":"任务2","status":"in_progress","priority":"medium"}
  ]]]></|DSML|parameter>
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input.todos).toBeInstanceOf(Array)
      expect((calls[0].input.todos as unknown[]).length).toBe(2)
    })

    it('应解析实际失败案例（用户报告的 bug）', () => {
      const text = `<|DSML|tool_calls>
  <|DSML|invoke name="todo_write">
    <|DSML|parameter name="todos"><![CDATA[[
      {"id": "1", "content": "读取 explore_login_page.py 获取正确选择器", "status": "in_progress", "priority": "high"},
      {"id": "2", "content": "读取 ui_fixed_test.py 当前代码", "status": "pending", "priority": "high"},
      {"id": "3", "content": "修正 ui_fixed_test.py 中的选择器", "status": "pending", "priority": "high"},
      {"id": "4", "content": "执行 UI 测试并记录结果", "status": "pending", "priority": "high"},
      {"id": "5", "content": "整合 API 和 UI 测试结果生成最终报告", "status": "pending", "priority": "medium"}
    ]]]></|DSML|parameter>
  </|DSML|invoke>
  <|DSML|invoke name="file_read">
    <|DSML|parameter name="path"><![CDATA[explore_login_page.py]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`

      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(2)

      // 第一个工具调用：todo_write
      expect(calls[0].name).toBe('todo_write')
      expect(calls[0].input.todos).toBeInstanceOf(Array)
      expect((calls[0].input.todos as unknown[]).length).toBe(5)

      // 第二个工具调用：file_read
      expect(calls[1].name).toBe('file_read')
      expect(calls[1].input).toEqual({ path: 'explore_login_page.py' })
    })

    it('应解析多个工具调用', () => {
      const text = `<|DSML|tool_calls>
  <|DSML|invoke name="todo_write">
    <|DSML|parameter name="todos"><![CDATA[[{"id":"1","content":"test"}]]]></|DSML|parameter>
  </|DSML|invoke>
  <|DSML|invoke name="todo_read"/>
  <|DSML|invoke name="file_read">
    <|DSML|parameter name="path">test.txt</|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`

      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(3)
      expect(calls[0].name).toBe('todo_write')
      expect(calls[1].name).toBe('todo_read')
      expect(calls[2].name).toBe('file_read')
    })

    it('应处理多个参数', () => {
      const text = `<|DSML|invoke name="file_write">
  <|DSML|parameter name="path">test.txt</|DSML|parameter>
  <|DSML|parameter name="content"><![CDATA[Hello World]]></|DSML|parameter>
</|DSML|invoke>`

      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input).toEqual({
        path: 'test.txt',
        content: 'Hello World',
      })
    })

    it('应处理 CDATA 内容中的特殊字符', () => {
      const text = `<|DSML|invoke name="bash">
  <|DSML|parameter name="command"><![CDATA[echo "test > output.txt"]]></|DSML|parameter>
</|DSML|invoke>`

      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input).toEqual({
        command: 'echo "test > output.txt"',
      })
    })

    it('应处理 CDATA 内容中的 XML 标签', () => {
      const text = `<|DSML|invoke name="file_write">
  <|DSML|parameter name="content"><![CDATA[<html><body>test</body></html>]]></|DSML|parameter>
</|DSML|invoke>`

      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input).toEqual({
        content: '<html><body>test</body></html>',
      })
    })

    it('应处理格式不规范的输入（容错）', () => {
      const text = `<|DSML|invoke name="test">
  <|DSML|parameter name="param1">value1</|DSML|parameter>
  some random text
  <|DSML|parameter name="param2">value2</|DSML|parameter>
</|DSML|invoke>`

      const calls = parseDsmlToolCalls(text)

      expect(calls).toHaveLength(1)
      expect(calls[0].input).toEqual({
        param1: 'value1',
        param2: 'value2',
      })
    })
  })

  describe('stripDsmlBlocks', () => {
    it('应移除 tool_calls 外层包装', () => {
      const text = `前文
<|DSML|tool_calls>
  <|DSML|invoke name="test"/>
</|DSML|tool_calls>
后文`
      const clean = stripDsmlBlocks(text)
      expect(clean).toBe('前文\n\n后文')
    })

    it('应移除自闭合 invoke 标签', () => {
      const text = '前文 <|DSML|invoke name="test"/> 后文'
      const clean = stripDsmlBlocks(text)
      expect(clean).toBe('前文  后文')
    })

    it('应移除普通 invoke 块', () => {
      const text = `前文
<|DSML|invoke name="test">
  <|DSML|parameter name="p">v</|DSML|parameter>
</|DSML|invoke>
后文`
      const clean = stripDsmlBlocks(text)
      expect(clean).toBe('前文\n\n后文')
    })

    it('应移除含 CDATA 的 invoke 块', () => {
      const text = `前文
<|DSML|invoke name="test">
  <|DSML|parameter name="p"><![CDATA[[{"id":"1"}]]]></|DSML|parameter>
</|DSML|invoke>
后文`
      const clean = stripDsmlBlocks(text)
      expect(clean).toBe('前文\n\n后文')
    })

    it('应保留非 DSML 文本', () => {
      const text = '这是普通文本，没有 DSML 标记'
      const clean = stripDsmlBlocks(text)
      expect(clean).toBe(text)
    })

    it('应处理混合文本和 DSML', () => {
      const text = `好的，我来更新任务列表。

<|DSML|tool_calls>
  <|DSML|invoke name="todo_write">
    <|DSML|parameter name="todos"><![CDATA[[{"id":"1","content":"test"}]]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`

      const clean = stripDsmlBlocks(text)
      expect(clean).toBe('好的，我来更新任务列表。')
    })
  })

  describe('parseDsml (一体化接口)', () => {
    it('应返回完整解析结果', () => {
      const text = `前文
<|DSML|tool_calls>
  <|DSML|invoke name="todo_read"/>
</|DSML|tool_calls>`

      const result = parseDsml(text)

      expect(result.hasDsml).toBe(true)
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].name).toBe('todo_read')
      expect(result.cleanText).toBe('前文')
    })

    it('应处理无 DSML 的文本', () => {
      const text = '这是普通文本'
      const result = parseDsml(text)

      expect(result.hasDsml).toBe(false)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.cleanText).toBe(text)
    })

    it('应处理有 DSML 标记但无工具调用的文本', () => {
      // <|DSML|invoke 出现但结构不完整，解析结果为空
      const text = '文本中提到了 <|DSML|invoke 但不是完整标签'
      const result = parseDsml(text)

      expect(result.hasDsml).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.cleanText).toBe(text)
    })
  })

  describe('边界情况', () => {
    it('应处理空文本', () => {
      const calls = parseDsmlToolCalls('')
      expect(calls).toHaveLength(0)
    })

    it('应处理不完整的 invoke 标签', () => {
      const text = '<|DSML|invoke name="test"'
      const calls = parseDsmlToolCalls(text)
      expect(calls).toHaveLength(0)
    })

    it('应处理缺少 name 属性的 invoke', () => {
      const text = '<|DSML|invoke/>'
      const calls = parseDsmlToolCalls(text)
      expect(calls).toHaveLength(0)
    })

    it('应处理不完整的 parameter 标签', () => {
      const text = `<|DSML|invoke name="test">
  <|DSML|parameter name="p">value
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)
      expect(calls).toHaveLength(1)
      expect(calls[0].input).toEqual({})  // 参数解析失败，返回空对象
    })

    it('应处理不完整的 CDATA', () => {
      // 当 CDATA 未闭合时，findCdataEnd 返回 -1，
      // findParamValueEnd 无法找到 </|DSML|parameter>，整个 invoke 被跳过
      const text = `<|DSML|invoke name="test">
  <|DSML|parameter name="p"><![CDATA[value</|DSML|parameter>
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)
      // CDATA 未闭合导致参数解析失败，invoke 被跳过
      expect(calls).toHaveLength(0)
    })

    it('应处理嵌套的 CDATA 结束标记（]]> 在 CDATA 内）', () => {
      // 注意：标准 CDATA 不允许内容中出现 ]]>，但我们的解析器应该找到第一个 ]]>
      const text = `<|DSML|invoke name="test">
  <|DSML|parameter name="p"><![CDATA[text with ]]> inside]]></|DSML|parameter>
</|DSML|invoke>`
      const calls = parseDsmlToolCalls(text)
      expect(calls).toHaveLength(1)
      // 会在第一个 ]]> 处停止，这是符合 XML CDATA 规范的行为
      expect(calls[0].input).toEqual({ p: 'text with ' })
    })
  })

  describe('性能测试', () => {
    it('应快速处理大量工具调用', () => {
      const invokes = Array.from({ length: 100 }, (_, i) =>
        `<|DSML|invoke name="tool_${i}"><|DSML|parameter name="id">${i}</|DSML|parameter></|DSML|invoke>`
      ).join('\n')

      const text = `<|DSML|tool_calls>\n${invokes}\n</|DSML|tool_calls>`

      const start = Date.now()
      const calls = parseDsmlToolCalls(text)
      const elapsed = Date.now() - start

      expect(calls).toHaveLength(100)
      expect(elapsed).toBeLessThan(100)  // 应在 100ms 内完成
    })

    it('应快速处理大型 CDATA 内容', () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        id: String(i),
        content: `任务 ${i}`,
        status: 'pending',
      }))

      // JSON.stringify(largeArray) 末尾已有 ]，CDATA 结束是 ]]>
      // 所以完整格式是 <![CDATA[...JSON...]]]>（JSON的] + CDATA的]]>）
      const text = `<|DSML|invoke name="todo_write">
  <|DSML|parameter name="todos"><![CDATA[${JSON.stringify(largeArray)}]]></|DSML|parameter>
</|DSML|invoke>`

      const start = Date.now()
      const calls = parseDsmlToolCalls(text)
      const elapsed = Date.now() - start

      expect(calls).toHaveLength(1)
      expect((calls[0].input.todos as unknown[]).length).toBe(1000)
      expect(elapsed).toBeLessThan(200)  // 应在 200ms 内完成
    })
  })
})
