# OpenClaw 安全与配置系统分析

---

## 一、多层沙箱系统

### 1.1 三后端架构

```typescript
type SandboxConfig = {
  mode: "off" | "non-main" | "all"
  backend: "docker" | "ssh" | "openshell"
  docker?: DockerSandboxConfig
  ssh?: SshSandboxConfig
  openshell?: OpenShellSandboxConfig
}
```

| 后端 | 场景 | 特点 |
|------|------|------|
| Docker | 本地容器隔离 | 绑定挂载验证、网络模式、seccomp/AppArmor |
| SSH | 远程机器隔离 | SSH 连接到远程机器执行 |
| OpenShell | 轻量级隔离 | 自有沙箱实现 |

### 1.2 Docker 安全验证

`validate-sandbox-security.ts` 维护危险路径黑名单：

```typescript
const DENY_HOST_PATHS = [
  "/etc", "/proc", "/sys", "/dev", "/root",
  "/run/docker.sock", "/var/run/docker.sock",
]

const DENY_HOME_SUBDIRS = [
  ".ssh", ".aws", ".docker", ".gnupg",
  ".npm", ".kube", ".config/gcloud",
]
```

验证维度：
- 绑定挂载路径检查
- 网络模式检查（禁止 `host` 网络）
- seccomp 配置文件验证
- AppArmor 配置文件验证

### 1.3 工具级沙箱策略

```typescript
type SandboxToolPolicy = {
  allow?: string[]      // 允许的工具（glob 模式）
  alsoAllow?: string[]  // 追加允许
  deny?: string[]       // 拒绝的工具（glob 模式）
}

// 解析优先级：agent-level → global-level → defaults
function resolveSandboxToolPolicyForAgent(agent, global, defaults): ToolPolicy {
  return mergePolicies([
    defaults,
    global,
    agent,
  ])
}
```

**示例**：
```yaml
sandbox:
  tools:
    allow: ["read_file", "list_directory"]
    deny: ["run_command", "write_file"]
    alsoAllow: ["web_search:*"]  # glob 模式
```

### 1.4 文件系统桥接

`fs-bridge-path-safety.ts` 提供宿主与沙箱容器之间的安全文件操作，确保路径遍历攻击无法突破沙箱边界。

---

## 二、外部内容隔离

### 2.1 随机边界标记

```typescript
function wrapExternalContent(content: string, source: string): string {
  const boundary = randomBytes(8).toString("hex")
  return `
<<<EXTERNAL_CONTENT_${boundary} source="${source}">>>
${content}
<<<END_EXTERNAL_CONTENT_${boundary}>>>
`
}
```

**设计价值**：使用随机字节生成边界标记，防止攻击者伪造边界。

### 2.2 提示注入检测

```typescript
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system:\s*/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  // ... 更多模式
]
```

### 2.3 LLM 特殊 Token 清洗

```typescript
function sanitizeLlmTokens(content: string): string {
  // ChatML
  content = content.replace(/<\|im_start\|>/g, "")
  content = content.replace(/<\|im_end\|>/g, "")

  // Llama
  content = content.replace(/<s>/g, "")
  content = content.replace(/<\/s>/g, "")

  // Mistral
  content = content.replace(/\[INST\]/g, "")
  content = content.replace(/\[\/INST\]/g, "")

  // Phi / Gemma
  content = content.replace(/<\|system\|>/g, "")
  content = content.replace(/<\|user\|>/g, "")
  content = content.replace(/<\|assistant\|>/g, "")

  return content
}
```

### 2.4 Unicode 同形字折叠

```typescript
function foldHomoglyphs(content: string): string {
  // 将 Unicode 同形字折叠为 ASCII 等价物
  // 防止使用变形字符绕过边界标记检测
  return content
    .replace(/[＜]/g, "<")  // 全角 <
    .replace(/[＞]/g, ">")  // 全角 >
    .replace(/[‹]/g, "<")  // 单左尖括号
    .replace(/[›]/g, ">")  // 单右尖括号
}
```

### 2.5 零宽字符移除

```typescript
const ZERO_WIDTH_CHARS = [
  "​",  // ZERO WIDTH SPACE
  "‌",  // ZERO WIDTH NON-JOINER
  "‍",  // ZERO WIDTH JOINER
  "⁠",  // WORD JOINER
  "﻿",  // ZERO WIDTH NO-BREAK SPACE
  "­",  // SOFT HYPHEN
]

function removeZeroWidthChars(content: string): string {
  return content.replace(new RegExp(ZERO_WIDTH_CHARS.join("|"), "g"), "")
}
```

---

## 三、DM 配对策略

### 3.1 消息渠道安全

```typescript
// 未知发送者收到配对码，而非直接访问
async function handleDm(senderId: string, message: string) {
  const isPaired = await checkPairingStatus(senderId)

  if (!isPaired) {
    const pairingCode = generatePairingCode()
    await sendPairingCode(senderId, pairingCode)
    return
  }

  // 已配对，正常处理
  await processMessage(senderId, message)
}
```

---

## 四、配置系统

### 4.1 Zod Schema 验证

```typescript
const ConfigSchema = z.object({
  agents: AgentDefaultsSchema,
  providers: ProvidersSchema,
  hooks: HooksSchema,
  sessions: SessionsSchema,
  tools: ToolsSchema,
  plugins: PluginsSchema,
  // ...
})
```

### 4.2 环境变量替换

```typescript
// 配置值可以引用环境变量
{
  "providers": {
    "openai": {
      "apiKey": "${OPENAI_API_KEY}"
    }
  }
}

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return process.env[varName] ?? ""
  })
}
```

### 4.3 Config 观察-恢复系统

```typescript
class ConfigObserver {
  // 文件指纹
  fingerprint(file: string): FileFingerprint {
    return {
      sha256: hashFile(file),
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
    }
  }

  // 检测可疑变更
  detectSuspiciousChange(current: FileFingerprint, last: FileFingerprint): boolean {
    // 文件突然变小
    if (current.size < last.size * 0.1) return true
    // 元数据丢失
    if (current.nlink !== last.nlink) return true
    return false
  }

  // 自动恢复
  async recover(file: string): Promise<boolean> {
    const backup = await this.findLastKnownGood(file)
    if (backup) {
      await fs.copyFile(backup, file)
      return true
    }
    return false
  }
}
```

### 4.4 配置备份轮转

```typescript
// 保留最近 N 个备份
const BACKUP_ROTATION_COUNT = 5

function rotateBackups(file: string): void {
  const backups = listBackups(file)
  while (backups.length >= BACKUP_ROTATION_COUNT) {
    const oldest = backups.shift()
    fs.unlinkSync(oldest)
  }
  fs.copyFileSync(file, generateBackupPath(file))
}
```

### 4.5 敏感值脱敏

```typescript
function redactSnapshot(config: object): object {
  return deepMap(config, (value, path) => {
    // API Key 脱敏
    if (isApiKeyPath(path)) return "***REDACTED***"
    // SecretRef 对象
    if (isSecretRef(value)) return { type: "secret", ref: "***" }
    // URL 中的敏感部分
    if (isSensitiveUrl(value)) return redactUrl(value)
    return value
  })
}
```

---

## 五、Auth Profile 使用量追踪

### 5.1 失败原因优先级

```typescript
const FAILURE_PRIORITY = [
  "auth_permanent",   // 永久认证失败
  "auth",             // 认证失败
  "billing",          // 计费问题
  "format",           // 格式错误
  "model_not_found",  // 模型不存在
  "overloaded",       // 过载
  "timeout",          // 超时
  "rate_limit",       // 速率限制
  "empty_response",   // 空响应
  "no_error_details", // 无错误详情
  "unclassified",     // 未分类
  "unknown",          // 未知
]
```

### 5.2 阶梯冷却回退

```typescript
const COOLDOWN_STEPS = [30_000, 60_000, 300_000]  // 30s, 1min, 5min（封顶）

function calculateCooldown(failureCount: number): number {
  const step = Math.min(failureCount, COOLDOWN_STEPS.length - 1)
  return COOLDOWN_STEPS[step]
}
```

### 5.3 模型级冷却

```typescript
// 如果某个模型触发速率限制，仅冷却该模型
// 如果不同模型也失败，扩大冷却范围到所有模型
function applyCooldown(profile: AuthProfile, model: string, error: Error) {
  if (error.type === "rate_limit") {
    profile.cooldowns.set(model, calculateCooldown(profile.failureCount))
  }

  // 检查是否需要扩大范围
  const distinctModels = countDistinctModelFailures(profile)
  if (distinctModels >= 2) {
    profile.cooldowns.set("*", calculateCooldown(profile.failureCount))
  }
}
```

### 5.4 WHAM 集成（OpenAI 使用量 API）

```typescript
// 探测 chatgpt.com/backend-api/wham/usage
async function probeWhamUsage(profile: AuthProfile): Promise<WhamUsage | null> {
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${profile.accessToken}` },
  })

  if (response.ok) {
    return {
      rateLimitWindow: data.rate_limit_window,
      usagePercent: data.usage_percent,
    }
  }

  return null
}
```

---

## 六、安全审计系统

### 6.1 openclaw doctor

```typescript
async function runSecurityAudit(mode: "shallow" | "deep"): Promise<AuditReport> {
  const checks = [
    checkFilesystemPermissions(),
    checkGatewayConfig(),
    checkChannelSecurity(),
    checkPluginTrust(),
    checkSandboxConfig(),
    checkDangerousFlags(),
    // deep 模式额外检查
    ...(mode === "deep" ? [
      checkCodeQLFindings(),
      checkDependencyVulnerabilities(),
    ] : []),
  ]

  return {
    passed: results.every(r => r.passed),
    results: await Promise.all(checks),
  }
}
```

### 6.2 CodeQL 安全查询（20+）

覆盖的信任边界：
- Agent Runtime
- Channel Runtime
- MCP Process
- Memory Runtime
- Network Runtime
- Plugin Trust
- Config System
- Sandbox System

---

## 七、关键设计特点

1. **多层沙箱** — Docker/SSH/OpenShell 三后端 + 工具级 allow/deny 策略
2. **外部内容隔离** — 随机边界 + 注入检测 + Token 清洗 + 同形字折叠 + 零宽字符移除
3. **配置观察-恢复** — SHA-256 指纹 + 可疑变更检测 + 自动备份恢复
4. **Auth Profile 冷却** — 阶梯回退 + 模型级冷却 + WHAM 集成
5. **安全审计** — openclaw doctor + 20+ CodeQL 查询
6. **敏感值脱敏** — 配置快照自动脱敏
