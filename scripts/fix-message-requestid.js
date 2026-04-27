#!/usr/bin/env node
/**
 * 数据修复脚本：为历史消息添加 requestId 字段
 * 
 * 修复策略：
 * 1. 读取所有会话的 transcript.jsonl 和归档文件
 * 2. 为每个 user 消息生成一个 requestId
 * 3. 该 user 消息之后的所有 assistant 和 tool 消息都使用同一个 requestId
 * 4. 直到遇到下一个 user 消息，生成新的 requestId
 * 5. 备份原文件为 .backup
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

const SESSIONS_DIR = join(homedir(), '.hrids-agent', 'sessions')

function generateRequestId() {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function fixMessagesInFile(filePath) {
  if (!existsSync(filePath)) {
    return { skipped: true, reason: 'file not found' }
  }

  // 读取原始消息
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(l => l.trim())
  if (lines.length === 0) {
    return { skipped: true, reason: 'empty file' }
  }

  const messages = lines.map(line => JSON.parse(line))
  
  // 检查是否需要修复：Message 对象本身是否有 requestId
  // （之前只修复了 content 块，现在需要检查 Message 级别）
  const needsFix = messages.some(msg => 
    (msg.role === 'user' || msg.role === 'assistant') && !msg.requestId
  )
  
  if (!needsFix) {
    return { skipped: true, reason: 'already has requestId' }
  }

  // 备份原文件
  const backupPath = `${filePath}.backup`
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(filePath))
  }

  // 修复消息：为每个对话轮次分配 requestId
  let currentRequestId = null
  let fixedCount = 0

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 新的用户消息，生成新的 requestId
      currentRequestId = generateRequestId()
      
      // 为 user 消息本身添加 requestId
      if (!msg.requestId) {
        msg.requestId = currentRequestId
        fixedCount++
      }
      
      // user 消息中的 content 块也需要添加 requestId
      if (Array.isArray(msg.content) && currentRequestId) {
        for (const block of msg.content) {
          if (!block.requestId) {
            block.requestId = currentRequestId
            fixedCount++
          }
        }
      }
    } else if (msg.role === 'assistant' && currentRequestId) {
      // 为 assistant 消息本身添加 requestId
      if (!msg.requestId) {
        msg.requestId = currentRequestId
        fixedCount++
      }
      
      // assistant 消息：在 content 数组的每个块中添加 requestId
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block.requestId) {
            block.requestId = currentRequestId
            fixedCount++
          }
        }
      }
    }
  }

  // 写回文件
  const newContent = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n'
  writeFileSync(filePath, newContent, 'utf-8')

  return { fixed: true, count: fixedCount }
}

function fixSessionMessages(sessionDir) {
  const results = []
  
  // 修复主 transcript 文件
  const transcriptPath = join(sessionDir, 'transcript.jsonl')
  if (existsSync(transcriptPath)) {
    const result = fixMessagesInFile(transcriptPath)
    results.push({ file: 'transcript.jsonl', ...result })
  }
  
  // 修复归档文件
  const files = readdirSync(sessionDir)
  const archiveFiles = files.filter(f => f.endsWith('.archive.jsonl'))
  
  for (const archiveFile of archiveFiles) {
    const archivePath = join(sessionDir, archiveFile)
    const result = fixMessagesInFile(archivePath)
    results.push({ file: archiveFile, ...result })
  }
  
  return results
}

function main() {
  console.log('🔧 开始修复历史消息数据...\n')
  console.log(`📁 会话目录: ${SESSIONS_DIR}\n`)

  if (!existsSync(SESSIONS_DIR)) {
    console.error('❌ 会话目录不存在')
    process.exit(1)
  }

  const sessions = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  console.log(`📊 找到 ${sessions.length} 个会话\n`)

  let totalFixedFiles = 0
  let totalSkippedFiles = 0
  let totalErrors = 0
  let totalBlocks = 0

  for (const sessionId of sessions) {
    const sessionDir = join(SESSIONS_DIR, sessionId)
    
    try {
      const results = fixSessionMessages(sessionDir)
      
      if (results.length === 0) {
        console.log(`⏭️  ${sessionId}: 无文件`)
        continue
      }
      
      let sessionFixed = 0
      let sessionSkipped = 0
      let sessionBlocks = 0
      
      for (const result of results) {
        if (result.skipped) {
          sessionSkipped++
        } else if (result.fixed) {
          sessionFixed++
          sessionBlocks += result.count
        }
      }
      
      if (sessionFixed > 0) {
        console.log(`✅ ${sessionId}: 修复了 ${sessionFixed} 个文件，共 ${sessionBlocks} 个消息块`)
        totalFixedFiles += sessionFixed
        totalBlocks += sessionBlocks
      } else {
        console.log(`⏭️  ${sessionId}: ${sessionSkipped} 个文件已跳过`)
      }
      totalSkippedFiles += sessionSkipped
      
    } catch (err) {
      console.error(`❌ ${sessionId}: 修复失败 - ${err.message}`)
      totalErrors++
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`\n📈 修复统计:`)
  console.log(`   ✅ 已修复: ${totalFixedFiles} 个文件`)
  console.log(`   📦 消息块: ${totalBlocks} 个`)
  console.log(`   ⏭️  已跳过: ${totalSkippedFiles} 个文件`)
  console.log(`   ❌ 失败: ${totalErrors} 个会话`)
  console.log(`\n💾 备份文件: *.backup`)
  console.log('\n✨ 修复完成！')
}

main()
