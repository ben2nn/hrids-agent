// 内置 skills 注册入口

import { registerBundledSkill } from '../registry.js'

export function registerAllBundledSkills(): void {
  // ================================================================
  // 通用工作者 skills（不局限于代码开发）
  // ================================================================

  // ---- /research ----
  registerBundledSkill({
    name: 'research',
    description: '对指定主题进行深度调研，输出结构化报告',
    argumentHint: '<调研主题或问题>',
    whenToUse: '用户需要对某个主题进行系统性调研时使用',
    async getPrompt(args) {
      return `# 深度调研任务

## 调研目标
${args || '对用户指定的主题进行调研'}

## 执行步骤
1. 用 memory_search 检索已有相关记忆，避免重复工作
2. 用 web_search 搜索主题的核心信息、最新动态、权威来源
3. 用 web_fetch 获取关键页面的详细内容
4. 整合信息，识别共识与分歧
5. 输出结构化报告

## 报告结构
- **核心结论**（3-5条最重要的发现）
- **详细分析**（按子主题展开）
- **信息来源**（列出主要参考来源）
- **不确定性**（哪些信息存疑或需要进一步确认）
- **建议行动**（基于调研结果的建议）

## 原则
- 区分事实与观点
- 注明信息的时效性
- 发现重要信息时用 memory_add 记录
- 不要只给表面信息，要深入分析`.trim()
    },
  })

  // ---- /plan ----
  registerBundledSkill({
    name: 'plan',
    description: '为复杂目标制定详细的执行计划',
    argumentHint: '<目标描述>',
    whenToUse: '用户需要为复杂任务制定计划时使用',
    async getPrompt(args) {
      return `# 制定执行计划

## 目标
${args || '为用户描述的目标制定计划'}

## 步骤
1. 理解目标：最终交付物是什么？成功标准是什么？
2. 分解任务：将目标拆解为可执行的子任务
3. 识别依赖：哪些任务必须串行，哪些可以并行
4. 评估风险：每个阶段的主要风险和应对方案
5. 制定时间线：合理估算每个阶段的工作量

## 计划输出格式
### 阶段划分
[按阶段列出，每个阶段有明确的目标和交付物]

### 任务清单
[用 todo_write 工具创建可追踪的任务列表]

### 关键决策点
[列出执行过程中需要人类决策的节点]

### 风险与应对
[主要风险及预案]

## 原则
- 计划要具体可执行，不要停留在抽象层面
- 明确标注哪些步骤需要用户决策
- 优先考虑可以并行的工作`.trim()
    },
  })

  // ---- /report ----
  registerBundledSkill({
    name: 'report',
    description: '将工作成果整理成结构化报告文档',
    argumentHint: '<报告主题或工作内容描述>',
    whenToUse: '用户需要将工作成果整理成报告时使用',
    async getPrompt(args) {
      return `# 生成工作报告

## 报告内容
${args || '整理当前工作成果'}

## 步骤
1. 用 memory_recall 和 memory_search 检索相关工作记录
2. 整理 todo_read 中的任务完成情况
3. 汇总关键成果、数据和结论
4. 生成结构化报告文件

## 报告结构（根据内容调整）
- **执行摘要**（1-2段，核心结论）
- **背景与目标**
- **工作内容**（按时间或主题组织）
- **主要成果**（量化指标优先）
- **问题与解决方案**
- **下一步建议**

## 输出
用 file_write 将报告保存为 Markdown 文件，路径：./reports/[日期]-[主题].md`.trim()
    },
  })

  // ---- /monitor ----
  registerBundledSkill({
    name: 'monitor',
    description: '设置对某个指标或状态的持续监控',
    argumentHint: '<监控目标描述>',
    whenToUse: '用户需要持续监控某个指标、网站或状态时使用',
    async getPrompt(args) {
      return `# 设置监控任务

## 监控目标
${args || '用户指定的监控对象'}

## 步骤
1. 明确监控对象：URL、文件、指标、状态
2. 确定检查频率（用 ask_user 询问，或根据上下文判断）
3. 确定告警条件：什么情况下需要通知用户
4. 用 schedule_cron 设置定时检查任务
5. 在 cron 任务的 task 字段中写入完整的检查逻辑

## 检查逻辑模板（写入 task 字段）
"检查 [目标]：
1. 获取当前状态（web_fetch 或 bash）
2. 与上次状态对比（从 memory_search 获取历史值）
3. 如果发生变化/超过阈值，用 request_decision 上报给用户
4. 用 memory_add 记录本次检查结果"

## 常用 cron 表达式
- 每小时: "0 * * * *"
- 每天早9点: "0 9 * * *"
- 工作日早9点: "0 9 * * 1-5"
- 每30分钟: "*/30 * * * *"`.trim()
    },
  })

  // ---- /summarize ----
  registerBundledSkill({
    name: 'summarize',
    description: '对文档、网页或长文本进行摘要提炼',
    argumentHint: '<文件路径、URL 或内容描述>',
    whenToUse: '用户需要快速理解长文档或多个文档的核心内容时使用',
    async getPrompt(args) {
      return `# 内容摘要

## 摘要对象
${args || '用户指定的内容'}

## 步骤
1. 获取内容（file_read 读取文件，或 web_fetch 获取网页）
2. 如果是多个文档，逐一读取
3. 提炼核心信息

## 摘要原则
- 保留最重要的信息，去掉冗余
- 保持原文的逻辑结构
- 数字、日期、专有名词保持准确
- 标注信息来源

## 输出格式
- **一句话总结**（最核心的结论）
- **要点列表**（5-10条关键信息）
- **详细摘要**（按原文结构展开）
- **值得关注**（特别重要或需要行动的内容）`.trim()
    },
  })

  // ================================================================
  // 代码开发 skills（原有）
  // ================================================================

  // ---- /commit ----
  registerBundledSkill({
    name: 'commit',
    description: '分析 git diff，生成规范的 commit 信息并提交',
    whenToUse: '用户想要提交代码变更时使用',
    async getPrompt(args) {
      return `# 生成 Git Commit

## 步骤
1. 运行 \`git diff --staged\`，若暂存区为空则先运行 \`git diff HEAD\`
2. 分析变更内容，理解改动的目的
3. 按照 Conventional Commits 规范生成 commit 信息：
   - 格式：\`<type>(<scope>): <subject>\`
   - type: feat / fix / refactor / docs / test / chore / style / perf
   - subject 使用中文，简洁描述变更
4. 若暂存区为空，先执行 \`git add -A\`
5. 执行 \`git commit -m "<生成的信息>"\`
6. 输出提交结果

${args ? `## 用户补充说明\n\n${args}` : ''}`.trim()
    },
  })

  // ---- /review ----
  registerBundledSkill({
    name: 'review',
    description: '对当前 git diff 进行代码审查，指出问题和改进建议',
    whenToUse: '用户想要审查代码变更时使用',
    async getPrompt(args) {
      return `# 代码审查

## 步骤
1. 运行 \`git diff HEAD\` 获取所有未提交变更
2. 逐文件分析变更，关注以下维度：
   - **正确性**：逻辑是否正确，边界条件是否处理
   - **安全性**：是否存在注入、越权、敏感信息泄露等风险
   - **性能**：是否有明显的性能问题
   - **可读性**：命名、注释、代码结构是否清晰
   - **测试**：是否需要补充测试
3. 输出结构化的审查报告：
   - 🔴 必须修复（阻塞合并）
   - 🟡 建议改进（非阻塞）
   - 🟢 优点（值得保留的好实践）

${args ? `## 审查重点\n\n${args}` : ''}`.trim()
    },
  })

  // ---- /explain ----
  registerBundledSkill({
    name: 'explain',
    description: '深入解释指定代码文件或代码片段的工作原理',
    argumentHint: '<文件路径或代码描述>',
    whenToUse: '用户想要理解某段代码的工作原理时使用',
    async getPrompt(args) {
      return `# 代码解释

## 目标
${args ? `解释以下内容：${args}` : '解释用户指定的代码'}

## 解释维度
1. **整体功能**：这段代码做什么
2. **核心逻辑**：关键算法或流程的逐步说明
3. **设计决策**：为什么这样实现，有什么权衡
4. **依赖关系**：依赖哪些外部模块或上下文
5. **使用示例**：如何调用或使用

使用清晰的中文解释，对复杂部分配合伪代码或流程图（用文字描述）。`.trim()
    },
  })

  // ---- /fix ----
  registerBundledSkill({
    name: 'fix',
    description: '分析并修复代码中的 bug 或错误',
    argumentHint: '[错误信息或问题描述]',
    whenToUse: '用户遇到 bug 或错误需要修复时使用',
    async getPrompt(args) {
      return `# Bug 修复

## 步骤
1. 理解问题：${args || '分析用户描述的问题'}
2. 定位根因：
   - 读取相关文件，理解上下文
   - 分析错误堆栈或异常信息
   - 找到导致问题的具体代码
3. 制定修复方案（先说明方案，再执行）
4. 实施修复，确保：
   - 不引入新的问题
   - 保持代码风格一致
   - 必要时添加注释说明修复原因
5. 验证修复：运行相关测试或手动验证

${args ? `## 问题描述\n\n${args}` : ''}`.trim()
    },
  })

  // ---- /scaffold ----
  registerBundledSkill({
    name: 'scaffold',
    description: '根据描述快速生成项目或模块的骨架代码',
    argumentHint: '<项目/模块描述>',
    whenToUse: '用户需要快速创建新项目或模块结构时使用',
    async getPrompt(args) {
      return `# 代码脚手架生成

## 目标
${args || '根据用户描述生成项目骨架'}

## 原则
1. **最小化**：只生成必要的文件，避免过度设计
2. **可运行**：生成的代码应该能立即运行
3. **清晰结构**：目录结构直观，职责分明
4. **中文注释**：关键部分添加中文注释

## 步骤
1. 确认技术栈和需求
2. 设计目录结构（先展示，再创建）
3. 生成核心文件（入口、配置、主要模块）
4. 生成 package.json / tsconfig.json 等配置
5. 说明如何启动和使用`.trim()
    },
  })

  // ---- /refactor ----
  registerBundledSkill({
    name: 'refactor',
    description: '对指定代码进行重构，提升可读性、可维护性或性能',
    argumentHint: '<文件路径或重构目标描述>',
    whenToUse: '用户需要重构代码时使用',
    async getPrompt(args) {
      return `# 代码重构

## 目标
${args || '对用户指定的代码进行重构'}

## 重构原则
1. **保持行为不变**：重构不改变外部可见行为
2. **小步前进**：每次只做一种类型的重构
3. **先理解后改**：读懂代码再动手
4. **说明理由**：每处改动说明为什么这样改

## 重构维度（按需选择）
- **命名**：变量/函数/类名更清晰表达意图
- **函数拆分**：过长函数拆成小函数
- **消除重复**：提取公共逻辑
- **简化条件**：复杂条件逻辑简化
- **类型安全**：加强 TypeScript 类型
- **错误处理**：统一错误处理模式

## 步骤
1. 读取目标文件，理解当前实现
2. 识别重构点，列出改动计划
3. 逐步实施重构（使用 file_edit 精确修改）
4. 确认改动后功能不变`.trim()
    },
  })

  // ---- /test ----
  registerBundledSkill({
    name: 'test',
    description: '为指定代码生成单元测试',
    argumentHint: '<文件路径或模块描述>',
    whenToUse: '用户需要为代码编写测试时使用',
    async getPrompt(args) {
      return `# 生成单元测试

## 目标
${args || '为用户指定的代码生成测试'}

## 步骤
1. 读取目标文件，理解接口和行为
2. 识别测试框架（package.json 中查找 jest/vitest/mocha 等）
3. 设计测试用例，覆盖：
   - 正常路径（happy path）
   - 边界条件（空值、极值、类型边界）
   - 错误路径（异常、失败情况）
4. 生成测试文件（命名规范：xxx.test.ts 或 xxx.spec.ts）
5. 确保测试可以直接运行

## 测试原则
- 每个测试只验证一件事
- 测试名称清晰描述预期行为
- 避免测试实现细节，测试行为
- Mock 外部依赖（网络、文件系统、数据库）`.trim()
    },
  })

  // ---- /docs ----
  registerBundledSkill({
    name: 'docs',
    description: '为代码生成文档注释或 README',
    argumentHint: '<文件路径或文档类型>',
    whenToUse: '用户需要为代码添加文档时使用',
    async getPrompt(args) {
      return `# 生成代码文档

## 目标
${args || '为用户指定的代码生成文档'}

## 文档类型（根据需求选择）

### 代码注释
- 为函数/类/接口添加 JSDoc / TSDoc 注释
- 说明参数、返回值、异常、使用示例
- 复杂逻辑添加行内注释

### README
- 项目简介和功能概述
- 安装和快速开始
- API 文档或使用示例
- 配置说明

## 步骤
1. 读取目标文件，理解代码结构
2. 确认文档类型（注释 or README）
3. 生成文档（使用 file_edit 添加注释，或 file_write 创建 README）
4. 确保文档准确反映代码行为`.trim()
    },
  })
}
