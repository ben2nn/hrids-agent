/**
 * MediaProcessor — 统一的媒体处理模块
 *
 * 职责：
 * 1. 图片压缩：用 sharp 将图片缩放到 LLM 最优分辨率（≤1568px），重编码为 JPEG
 * 2. 缓存：对同一来源（文件路径 / URL）的图片避免重复处理，LRU 内存缓存
 * 3. URL 图片：支持 @https://... 语法，fetch 后走同一压缩流程
 * 4. PDF：作为 document 类型直接传给支持 PDF 的 LLM（Anthropic 原生支持）
 *
 * 所有入口都返回统一的 MediaAttachment 结构，与 ContentBlock image/document 对齐。
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { resolve, extname, basename, relative, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { logger } from '../shared/logger.js'

const log = logger.child({ component: 'media-processor' })

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface MediaAttachment {
  name: string
  data: string        // base64 编码
  mediaType: string   // MIME 类型
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** Anthropic 视觉模型的最优边长上限（超过此值会被服务端缩放，但 base64 仍全量传输） */
const MAX_DIMENSION = 1568

/** JPEG 重编码质量（85 在质量和体积间取得良好平衡） */
const JPEG_QUALITY = 85

/** 单张图片 base64 体积上限（约 5MB 原始 → ~7MB base64），超过则强制压缩 */
const MAX_RAW_BYTES = 5 * 1024 * 1024

/** LRU 缓存最大条目数 */
const CACHE_MAX_SIZE = 50

/** URL fetch 超时（ms） */
const FETCH_TIMEOUT_MS = 15_000

// ── MIME 规范化 ───────────────────────────────────────────────────────────────

/**
 * 清洗 MIME 类型：去掉参数部分（如 "; charset=utf-8"），统一小写。
 * 同时将非标准写法映射到 Anthropic 接受的标准值。
 */
function normalizeMime(raw: string): string {
  const base = raw.split(';')[0].trim().toLowerCase()
  // 统一别名
  const aliases: Record<string, string> = {
    'image/jpg': 'image/jpeg',
    'image/tif': 'image/tiff',
    'image/x-png': 'image/png',
  }
  return aliases[base] ?? base
}

// ── 支持的格式 ────────────────────────────────────────────────────────────────

/** 图片扩展名 → MIME 类型（sharp 可处理） */
const IMAGE_EXT_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
}

/** PDF 扩展名 → MIME 类型（直接传给 LLM，不经过 sharp） */
const PDF_EXT_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
}

/** 所有支持的扩展名（图片 + PDF） */
export const SUPPORTED_EXTS = new Set([...Object.keys(IMAGE_EXT_MAP), ...Object.keys(PDF_EXT_MAP)])

/** 从 MIME 类型判断是否为图片（需要 sharp 处理） */
function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

// ── LRU 缓存 ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  attachment: MediaAttachment
  /** 原始来源标识（文件路径 / URL），用于日志 */
  source: string
  /** 缓存时间（ms） */
  cachedAt: number
}

class MediaCache {
  private map = new Map<string, CacheEntry>()
  /** URL 缓存 TTL（1 小时），文件缓存通过 mtime+size 自动失效不受此限 */
  private static URL_TTL_MS = 3600_000

  /** 生成缓存 key：文件用 path+mtime，URL 用 URL 本身 */
  static keyForFile(absPath: string): string {
    try {
      const { mtimeMs, size } = statSync(absPath)
      return createHash('sha1').update(`file:${absPath}:${mtimeMs}:${size}`).digest('hex')
    } catch {
      return createHash('sha1').update(`file:${absPath}`).digest('hex')
    }
  }

  static keyForUrl(url: string): string {
    return createHash('sha1').update(`url:${url}`).digest('hex')
  }

  static keyForBuffer(buf: Buffer, hint: string): string {
    // 对大 buffer 只取前 4KB + 尾 4KB + 长度做 hash，避免全量 hash 耗时
    const sample = buf.length > 8192
      ? Buffer.concat([buf.slice(0, 4096), buf.slice(-4096), Buffer.from(String(buf.length))])
      : buf
    return createHash('sha1').update(`buf:${hint}:`).update(sample).digest('hex')
  }

  get(key: string): MediaAttachment | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    // URL 缓存 TTL 检查：超过 1 小时视为过期
    if (entry.source.startsWith('http') && Date.now() - entry.cachedAt > MediaCache.URL_TTL_MS) {
      this.map.delete(key)
      return undefined
    }
    // LRU：访问时移到末尾
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.attachment
  }

  set(key: string, attachment: MediaAttachment, source: string): void {
    if (this.map.size >= CACHE_MAX_SIZE) {
      // 淘汰最旧的条目（Map 迭代顺序 = 插入顺序）
      const oldest = this.map.keys().next().value
      if (oldest) this.map.delete(oldest)
    }
    this.map.set(key, { attachment, source, cachedAt: Date.now() })
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

// 进程级单例缓存（跨会话共享，节省内存）
const globalCache = new MediaCache()

// ── sharp 懒加载（避免 import 失败时整个模块崩溃）────────────────────────────

let sharpModule: typeof import('sharp') | null | 'unavailable' = null

async function getSharp(): Promise<typeof import('sharp') | null> {
  if (sharpModule === 'unavailable') return null
  if (sharpModule !== null) return sharpModule
  try {
    sharpModule = (await import('sharp')).default as unknown as typeof import('sharp')
    log.debug('sharp 模块加载成功')
    return sharpModule
  } catch (err) {
    log.warn('sharp 模块不可用，图片将不压缩直接传输', { error: String(err) })
    sharpModule = 'unavailable'
    return null
  }
}

// ── 核心压缩函数 ──────────────────────────────────────────────────────────────

/**
 * 压缩图片 Buffer：
 * - 若尺寸超过 MAX_DIMENSION，等比缩放
 * - 重编码为 JPEG（quality=85），GIF/WebP 保留原格式
 * - 若 sharp 不可用，原样返回
 */
async function compressImage(
  input: Buffer,
  originalMime: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const sharp = await getSharp()
  if (!sharp) {
    log.warn('sharp 不可用，跳过压缩', { originalMime, size: input.length })
    return { buffer: input, mime: originalMime }
  }

  try {
    let pipeline = sharp(input).rotate() // 自动修正 EXIF 旋转

    // 获取元数据以判断是否需要缩放
    const meta = await pipeline.metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0

    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
      pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
    }

    // GIF 保留原格式（sharp 对 GIF 动画支持有限，避免破坏）
    // 其他格式统一转 JPEG（体积最小，LLM 支持最好）
    let outputBuffer: Buffer
    let outputMime: string

    if (originalMime === 'image/gif') {
      outputBuffer = await pipeline.gif().toBuffer()
      outputMime = 'image/gif'
    } else {
      outputBuffer = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
      outputMime = 'image/jpeg'
    }

    const ratio = outputBuffer.length / input.length
    log.debug('图片压缩完成', {
      originalSize: input.length,
      compressedSize: outputBuffer.length,
      ratio: ratio.toFixed(2),
      originalMime,
      outputMime,
      originalDims: `${w}x${h}`,
    })

    return { buffer: outputBuffer, mime: outputMime }
  } catch (err) {
    log.warn('图片压缩失败，使用原始数据', { error: String(err), mime: originalMime })
    return { buffer: input, mime: originalMime }
  }
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 从本地文件路径加载媒体附件（带缓存 + 压缩）。
 *
 * @param absPath  绝对路径
 * @param name     附件名称（用于 LLM 上下文，默认取文件名）
 */
export async function loadMediaFromFile(
  absPath: string,
  name?: string,
): Promise<MediaAttachment | null> {
  if (!existsSync(absPath)) return null

  const ext = extname(absPath).toLowerCase()
  const imageMime = IMAGE_EXT_MAP[ext]
  const pdfMime = PDF_EXT_MAP[ext]
  const mime = imageMime ?? pdfMime
  if (!mime) return null
  const cacheKey = MediaCache.keyForFile(absPath)
  const cached = globalCache.get(cacheKey)
  if (cached) {
    log.debug('命中文件缓存', { path: absPath })
    return cached
  }

  try {
    const raw = readFileSync(absPath)

    let finalBuffer: Buffer
    let finalMime: string

    if (imageMime) {
      // 图片：压缩处理
      const needsCompress = raw.length > MAX_RAW_BYTES
      if (needsCompress) {
        log.debug('图片超过体积阈值，触发压缩', { path: absPath, size: raw.length })
      }
      const result = await compressImage(raw, imageMime)
      finalBuffer = result.buffer
      finalMime = result.mime
    } else {
      // PDF：直接传输，不经过 sharp
      finalBuffer = raw
      finalMime = pdfMime!
    }

    const attachment: MediaAttachment = {
      name: name ?? basename(absPath),
      data: finalBuffer.toString('base64'),
      mediaType: finalMime,
    }

    globalCache.set(cacheKey, attachment, absPath)
    return attachment
  } catch (err) {
    log.warn('读取媒体文件失败', { path: absPath, error: String(err) })
    return null
  }
}

/**
 * 从 URL 加载媒体附件（fetch + 压缩 + 缓存）。
 *
 * @param url  HTTP/HTTPS URL
 */
export async function loadMediaFromUrl(url: string): Promise<MediaAttachment | null> {
  const cacheKey = MediaCache.keyForUrl(url)
  const cached = globalCache.get(cacheKey)
  if (cached) {
    log.debug('命中 URL 缓存', { url })
    return cached
  }

  log.debug('fetch URL 图片', { url })

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      log.warn('URL 图片 fetch 失败', { url, status: response.status })
      return null
    }

    const contentType = response.headers.get('content-type') ?? ''
    // 从 Content-Type 或 URL 扩展名推断 MIME，并规范化
    let mime = normalizeMime(contentType)
    if (!mime || mime === 'application/octet-stream') {
      const urlExt = extname(new URL(url).pathname).toLowerCase()
      mime = normalizeMime(IMAGE_EXT_MAP[urlExt] ?? PDF_EXT_MAP[urlExt] ?? '')
    }

    if (!mime) {
      log.warn('无法识别 URL 资源类型', { url, contentType })
      return null
    }

    const arrayBuffer = await response.arrayBuffer()
    const raw = Buffer.from(arrayBuffer)

    let finalBuffer: Buffer
    let finalMime: string

    if (isImageMime(mime)) {
      const result = await compressImage(raw, mime)
      finalBuffer = result.buffer
      finalMime = result.mime
    } else if (mime === 'application/pdf') {
      finalBuffer = raw
      finalMime = mime
    } else {
      log.warn('URL 资源类型不支持', { url, mime })
      return null
    }

    const urlName = basename(new URL(url).pathname) || 'image.jpg'
    const attachment: MediaAttachment = {
      name: urlName,
      data: finalBuffer.toString('base64'),
      mediaType: finalMime,
    }

    globalCache.set(cacheKey, attachment, url)
    return attachment
  } catch (err) {
    log.warn('URL 图片加载失败', { url, error: String(err) })
    return null
  }
}

/**
 * 从内存 Buffer 处理媒体附件（带压缩 + 缓存，供 IM 适配器使用）。
 *
 * @param buffer    原始数据
 * @param mime      MIME 类型
 * @param name      附件名称
 */
export async function loadMediaFromBuffer(
  buffer: Buffer,
  mime: string,
  name: string,
): Promise<MediaAttachment> {
  // 规范化 MIME：去掉参数、统一别名
  const cleanMime = normalizeMime(mime)

  const cacheKey = MediaCache.keyForBuffer(buffer, name)
  const cached = globalCache.get(cacheKey)
  if (cached) {
    log.debug('命中 Buffer 缓存', { name })
    return cached
  }

  let finalBuffer: Buffer
  let finalMime: string

  if (isImageMime(cleanMime)) {
    const result = await compressImage(buffer, cleanMime)
    finalBuffer = result.buffer
    finalMime = result.mime
  } else {
    finalBuffer = buffer
    finalMime = cleanMime
  }

  const attachment: MediaAttachment = {
    name,
    data: finalBuffer.toString('base64'),
    mediaType: finalMime,
  }

  globalCache.set(cacheKey, attachment, name)
  return attachment
}

/**
 * 解析消息文本中的 @引用，提取所有媒体附件。
 *
 * 支持的语法：
 *   @filename.jpg          → 相对于 cwd 或 uploadsDir 的本地文件
 *   @/abs/path/img.png     → 绝对路径
 *   @https://example.com/img.jpg  → URL 图片
 *
 * 返回：
 *   - attachments: 成功加载的附件列表
 *   - cleanText:   去掉所有 @引用后的纯文本（避免 @filename 污染 LLM 上下文）
 *   - errors:      加载失败的引用及原因
 */
export async function extractMediaFromText(
  text: string,
  cwd: string,
  uploadsDir?: string,
): Promise<{
  attachments: MediaAttachment[]
  cleanText: string
  errors: string[]
}> {
  // 匹配 @引用：
  //   URL：@https://... 或 @http://...（到第一个空白结束）
  //   本地文件：@任意非空白字符，以支持的图片/PDF扩展名结尾
  // 注意：文件名可能含中文、空格以外的任意字符（括号、连字符等）
  const AT_MEDIA_RE = /@(https?:\/\/\S+|[^\s@]+\.(?:jpg|jpeg|png|gif|webp|bmp|tiff?|avif|pdf))/gi

  const matches = [...text.matchAll(AT_MEDIA_RE)]
  if (matches.length === 0) {
    return { attachments: [], cleanText: text, errors: [] }
  }

  const attachments: MediaAttachment[] = []
  const errors: string[] = []
  // 记录需要从 cleanText 中移除的片段（match[0] = "@xxx"）
  const toRemove = new Set<string>()

  await Promise.all(matches.map(async (m) => {
    const ref = m[1]  // 不含 @
    const full = m[0] // 含 @

    let attachment: MediaAttachment | null = null

    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      attachment = await loadMediaFromUrl(ref)
      if (!attachment) errors.push(`URL 加载失败: ${ref}`)
    } else {
      // 搜索顺序：cwd → uploadsDir
      const absPath = resolve(cwd, ref)
      // 路径遍历防护：确保解析后的路径仍在 cwd 内
      const relFromCwd = relative(cwd, absPath)
      if (relFromCwd.startsWith('..') || isAbsolute(relFromCwd)) {
        errors.push(`文件路径越界: ${ref}`)
        return
      }
      attachment = await loadMediaFromFile(absPath, ref)
      if (!attachment && uploadsDir) {
        const uploadsPath = resolve(uploadsDir, ref)
        attachment = await loadMediaFromFile(uploadsPath, ref)
      }
      if (!attachment) errors.push(`文件不存在或格式不支持: ${ref}`)
    }

    if (attachment) {
      attachments.push(attachment)
      toRemove.add(full)
    }
  }))

  // 从文本中移除成功加载的 @引用，保留失败的（让 LLM 知道有引用但加载失败）
  let cleanText = text
  for (const ref of toRemove) {
    cleanText = cleanText.replaceAll(ref, '').trim()
  }
  // 清理多余空白
  cleanText = cleanText.replace(/\s{2,}/g, ' ').trim()

  return { attachments, cleanText, errors }
}

/** 清空全局缓存（测试用） */
export function clearMediaCache(): void {
  globalCache.clear()
}

/** 获取缓存统计 */
export function getMediaCacheStats(): { size: number; maxSize: number } {
  return { size: globalCache.size, maxSize: CACHE_MAX_SIZE }
}
