/**
 * 系统代理自动注入
 *
 * Node.js 不会自动读取操作系统的系统代理设置。
 * 此模块在进程启动时检测系统代理配置，若已启用且环境变量中尚未配置代理，
 * 则自动将代理地址注入到 HTTP_PROXY / HTTPS_PROXY 环境变量，
 * 使 undici / fetch 等网络库能够自动走代理。
 *
 * 支持平台：
 * - Windows：读取注册表 HKCU\...\Internet Settings
 * - macOS：读取 networksetup 命令输出
 * - Linux（GNOME）：读取 gsettings org.gnome.system.proxy
 * - Linux（通用）：读取 /etc/environment 或 ~/.profile 中的环境变量
 */

import { execFileSync, execSync } from 'child_process'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

// ── 工具函数 ──────────────────────────────────────────────────────────────

/** 补全代理 URL 的协议前缀 */
function normalizeProxyUrl(url: string): string {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return `http://${url}`
  }
  return url
}

/** 将代理地址注入到所有相关环境变量，并设置 undici 全局 dispatcher */
function injectProxy(proxyUrl: string): void {
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  process.env.http_proxy = proxyUrl
  process.env.https_proxy = proxyUrl
  // undici 8.x 中 ProxyAgent 构造 API 有变化，用 EnvHttpProxyAgent 作为全局
  // dispatcher 更稳定，它会自动读取上面注入的环境变量
  setGlobalDispatcher(new EnvHttpProxyAgent())
  console.log(`[proxy] 已自动读取系统代理: ${proxyUrl}`)
}

// ── Windows ───────────────────────────────────────────────────────────────

const WIN_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

function winRegQuery(valueName: string): string | undefined {
  try {
    const output = execFileSync('reg', ['query', WIN_REG_KEY, '/v', valueName], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // REG_SZ 格式：    ValueName    REG_SZ    value
    const szMatch = output.match(/REG_SZ\s+(.+)/)
    if (szMatch) return szMatch[1].trim()
    // REG_DWORD 格式：    ValueName    REG_DWORD    0x1
    const dwordMatch = output.match(/REG_DWORD\s+(\w+)/)
    if (dwordMatch) return String(parseInt(dwordMatch[1], 16))
    return undefined
  } catch {
    return undefined
  }
}

function setupWindows(): boolean {
  const proxyEnable = winRegQuery('ProxyEnable')
  if (proxyEnable !== '1') return false

  const proxyServer = winRegQuery('ProxyServer')
  if (!proxyServer) return false

  // ProxyServer 格式可能是 "host:port" 或 "http=host:port;https=host:port;..."
  let proxyUrl: string | undefined
  if (proxyServer.includes('=')) {
    const map: Record<string, string> = {}
    for (const part of proxyServer.split(';')) {
      const eqIdx = part.indexOf('=')
      if (eqIdx > 0) {
        map[part.slice(0, eqIdx).trim().toLowerCase()] = part.slice(eqIdx + 1).trim()
      }
    }
    proxyUrl = map['https'] ?? map['http']
  } else {
    proxyUrl = proxyServer
  }

  if (!proxyUrl) return false
  injectProxy(normalizeProxyUrl(proxyUrl))
  return true
}

// ── macOS ─────────────────────────────────────────────────────────────────

function setupMacOS(): boolean {
  try {
    // 获取所有网络服务名称
    const services = execSync('networksetup -listallnetworkservices 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000,
    }).split('\n').filter(s => s && !s.startsWith('*') && !s.includes('denotes'))

    for (const service of services.slice(0, 5)) {
      // 尝试 HTTPS 代理
      const httpsOut = execSync(`networksetup -getsecurewebproxy "${service}" 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      })
      const httpsEnabled = httpsOut.match(/Enabled:\s*Yes/i)
      const httpsServer = httpsOut.match(/Server:\s*(.+)/)
      const httpsPort = httpsOut.match(/Port:\s*(\d+)/)
      if (httpsEnabled && httpsServer?.[1]?.trim() && httpsPort?.[1]) {
        const url = normalizeProxyUrl(`${httpsServer[1].trim()}:${httpsPort[1]}`)
        injectProxy(url)
        return true
      }

      // 尝试 HTTP 代理
      const httpOut = execSync(`networksetup -getwebproxy "${service}" 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      })
      const httpEnabled = httpOut.match(/Enabled:\s*Yes/i)
      const httpServer = httpOut.match(/Server:\s*(.+)/)
      const httpPort = httpOut.match(/Port:\s*(\d+)/)
      if (httpEnabled && httpServer?.[1]?.trim() && httpPort?.[1]) {
        const url = normalizeProxyUrl(`${httpServer[1].trim()}:${httpPort[1]}`)
        injectProxy(url)
        return true
      }
    }
  } catch {
    // networksetup 不可用，静默跳过
  }
  return false
}

// ── Linux（GNOME gsettings）──────────────────────────────────────────────

function setupLinuxGnome(): boolean {
  try {
    const mode = execSync('gsettings get org.gnome.system.proxy mode 2>/dev/null', {
      encoding: 'utf-8', timeout: 2000,
    }).trim().replace(/'/g, '')

    if (mode !== 'manual') return false

    // 尝试 HTTPS 代理
    const httpsHost = execSync('gsettings get org.gnome.system.proxy.https host 2>/dev/null', {
      encoding: 'utf-8', timeout: 2000,
    }).trim().replace(/'/g, '')
    const httpsPort = execSync('gsettings get org.gnome.system.proxy.https port 2>/dev/null', {
      encoding: 'utf-8', timeout: 2000,
    }).trim()

    if (httpsHost && httpsPort && httpsPort !== '0') {
      injectProxy(normalizeProxyUrl(`${httpsHost}:${httpsPort}`))
      return true
    }

    // 尝试 HTTP 代理
    const httpHost = execSync('gsettings get org.gnome.system.proxy.http host 2>/dev/null', {
      encoding: 'utf-8', timeout: 2000,
    }).trim().replace(/'/g, '')
    const httpPort = execSync('gsettings get org.gnome.system.proxy.http port 2>/dev/null', {
      encoding: 'utf-8', timeout: 2000,
    }).trim()

    if (httpHost && httpPort && httpPort !== '0') {
      injectProxy(normalizeProxyUrl(`${httpHost}:${httpPort}`))
      return true
    }
  } catch {
    // gsettings 不可用（非 GNOME 环境），静默跳过
  }
  return false
}

// ── 入口 ──────────────────────────────────────────────────────────────────

export function setupSystemProxy(): void {
  // 已有显式代理配置时不覆盖
  const existing =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (existing) return

  switch (process.platform) {
    case 'win32':
      setupWindows()
      break
    case 'darwin':
      setupMacOS()
      break
    case 'linux':
      // GNOME 桌面环境
      setupLinuxGnome()
      // KDE / 其他桌面：通常会自动设置环境变量，EnvHttpProxyAgent 能读到
      break
    default:
      break
  }
}
