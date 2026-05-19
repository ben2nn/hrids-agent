// 网络策略 —— 按域名控制网络访问
//
// 设计依据：DeepSeek-TUI 的 NetworkPolicyDecider
// 定位：为 WebFetch/WebSearch 等网络工具提供域名级访问控制，防止 SSRF 和数据外泄

export type NetworkDecision = 'allow' | 'deny'

export interface NetworkPolicyConfig {
  /** 白名单域名（优先级最高，设置后仅允许这些域名） */
  allowedDomains?: string[]
  /** 黑名单域名（在白名单未设置时生效） */
  blockedDomains?: string[]
  /** 白名单和黑名单都未设置时的默认行为 */
  defaultAction: 'allow' | 'deny'
}

// 默认的安全策略：阻止云平台 metadata 端点和本地地址
const DEFAULT_BLOCKED_DOMAINS = [
  '169.254.169.254',       // AWS/GCP/Azure metadata
  'metadata.google.internal',
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]

export class NetworkPolicyDecider {
  private config: NetworkPolicyConfig
  /** 合并后的有效黑名单（始终包含 DEFAULT_BLOCKED_DOMAINS） */
  private effectiveBlocked: string[]

  constructor(config?: NetworkPolicyConfig) {
    this.config = config ?? { defaultAction: 'allow' }
    // 安全关键的默认阻止域名始终生效，不因用户自定义配置而被丢弃
    const userBlocked = this.config.blockedDomains ?? []
    this.effectiveBlocked = [...new Set([...DEFAULT_BLOCKED_DOMAINS, ...userBlocked])]
  }

  /** 判断 URL 是否允许访问 */
  decide(url: string): { decision: NetworkDecision; reason?: string } {
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      return { decision: 'deny', reason: `无效的 URL: ${url}` }
    }

    // IP 地址直接检查（不走域名匹配）
    const isPrivateIP = isPrivateOrReservedIP(hostname)

    // 白名单模式：只允许列表中的域名
    if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
      const allowed = this.config.allowedDomains.some(d => domainMatches(hostname, d))
      if (allowed) return { decision: 'allow' }
      return { decision: 'deny', reason: `域名 ${hostname} 不在白名单中` }
    }

    // 黑名单模式（始终包含默认安全域名）
    if (this.effectiveBlocked.length > 0) {
      const blocked = this.effectiveBlocked.some(d => domainMatches(hostname, d))
      if (blocked) return { decision: 'deny', reason: `域名 ${hostname} 在黑名单中` }
    }

    // 私有/保留 IP 地址默认拒绝（防止 SSRF）
    if (isPrivateIP) {
      return { decision: 'deny', reason: `拒绝访问私有/保留 IP 地址: ${hostname}` }
    }

    // 默认行为
    if (this.config.defaultAction === 'deny') {
      return { decision: 'deny', reason: `域名 ${hostname} 未在允许列表中` }
    }

    return { decision: 'allow' }
  }

  /** 获取当前策略摘要（用于日志和调试） */
  describe(): string {
    const parts: string[] = []
    if (this.config.allowedDomains?.length) {
      parts.push(`白名单: ${this.config.allowedDomains.join(', ')}`)
    }
    if (this.config.blockedDomains?.length) {
      parts.push(`黑名单: ${this.config.blockedDomains.join(', ')}`)
    }
    parts.push(`默认: ${this.config.defaultAction}`)
    return parts.join(' | ')
  }
}

/** 域名匹配：精确匹配或子域名匹配 */
function domainMatches(hostname: string, pattern: string): boolean {
  if (hostname === pattern) return true
  // 子域名匹配：*.example.com 匹配 sub.example.com
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)  // .example.com
    return hostname.endsWith(suffix)
  }
  return hostname.endsWith(`.${pattern}`)
}

/** 检查是否为私有/保留 IP 地址 */
function isPrivateOrReservedIP(hostname: string): boolean {
  // IPv4 私有地址（10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16）
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) return true
  // 回环地址（127.0.0.0/8, ::1, 0.0.0.0）
  if (/^(127\.|::1$|0\.0\.0\.0$)/.test(hostname)) return true
  // Link-local（169.254.0.0/16, fe80::/10）
  if (/^(169\.254\.|fe80:)/i.test(hostname)) return true
  // IPv6 私有地址（fc00::/7 ULA）
  if (/^(fc|fd)/i.test(hostname)) return true
  // IPv4-mapped IPv6（::ffff:127.0.0.1 等）
  if (/^::ffff:/i.test(hostname)) return true
  return false
}
