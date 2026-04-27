#!/usr/bin/env node
/**
 * 验证脚本：检查所有历史消息（包括归档文件）是否都有 requestId
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SESSIONS_DIR = join(homedir(), '.hrids-agent', 'sessions')

function verifyFile(filePath) {
  if (!existsSync(filePath)) {
    return { valid: true, reason: 'file not found' }
  }

  const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(l => l.trim())
  if (lines.length === 0) {
    return { valid: true, reason: 'empty file' }
  }

  const messages = lines.map(line => JSON.parse(line))
  
  let missingCount = 0
  let totalItems = 0

  for (const msg of messages) {
    // 检查 Message 对象本身的 requestId
    if (msg.role === 'user' || msg.role === 'assistant') {
      totalItems++
      if (!msg.requestId) {
        missingCount++
      }
    }
    
    // 检查 content 块的 requestId
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        totalItems++
        if (!block.requestId) {
          missingCount++
        }
      }
    }
  }

  if (missingCount > 0) {
    return { valid: false, missingCount, totalItems }
  }

  return { valid: true, totalItems }
}

function verifySession(sessionDir) {
  const results = []
  
  // 验证主 transcript 文件
  const transcriptPath = join(sessionDir, 'transcript.jsonl')
  if (existsSync(transcriptPath)) {
    const result = verifyFile(transcriptPath)
    results.push({ file: 'transcript.jsonl', ...result })
  }
  
  // 验证归档文件
  const files = readdirSync(sessionDir)
  const archiveFiles = files.filter(f => f.endsWith('.archive.jsonl'))
  
  for (const archiveFile of archiveFiles) {
    const archivePath = join(sessionDir, archiveFile)
    const result = verifyFile(archivePath)
    results.push({ file: archiveFile, ...result })
  }
  
  return results
}

function main() {
  console.log('🔍 验证历史消息数据...\n')
  console.log(`📁 会话目录: ${SESSIONS_DIR}\n`)

  if (!existsSync(SESSIONS_DIR)) {
    console.error('❌ 会话目录不存在')
    process.exit(1)
  }

  const sessions = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  console.log(`📊 检查 ${sessions.length} 个会话\n`)

  let totalValidFiles = 0
  let totalInvalidFiles = 0
  let totalItems = 0

  for (const sessionId of sessions) {
    const sessionDir = join(SESSIONS_DIR, sessionId)
    
    try {
      const results = verifySession(sessionDir)
      
      if (results.length === 0) {
        console.log(`⏭️  ${sessionId}: 无文件`)
        continue
      }
      
      let sessionValid = 0
      let sessionInvalid = 0
      let sessionItems = 0
      
      for (const result of results) {
        if (result.valid) {
          if (result.totalItems > 0) {
            sessionValid++
            sessionItems += result.totalItems
          }
        } else {
          sessionInvalid++
          console.log(`   ❌ ${result.file}: 缺少 ${result.missingCount}/${result.totalItems} 个 requestId`)
        }
      }
      
      if (sessionInvalid === 0) {
        const fileCount = results.filter(r => r.totalItems > 0).length
        console.log(`✅ ${sessionId}: ${fileCount} 个文件，共 ${sessionItems} 项都有 requestId`)
        totalItems += sessionItems
      }
      
      totalValidFiles += sessionValid
      totalInvalidFiles += sessionInvalid
      
    } catch (err) {
      console.error(`❌ ${sessionId}: 验证失败 - ${err.message}`)
      totalInvalidFiles++
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`\n📈 验证结果:`)
  console.log(`   ✅ 有效: ${totalValidFiles} 个文件`)
  console.log(`   ❌ 无效: ${totalInvalidFiles} 个文件`)
  console.log(`   📦 总计: ${totalItems} 项（消息 + 内容块）`)
  
  if (totalInvalidFiles === 0) {
    console.log('\n✨ 所有数据都已正确修复！')
  } else {
    console.log('\n⚠️  仍有数据需要修复')
    process.exit(1)
  }
}

main()
