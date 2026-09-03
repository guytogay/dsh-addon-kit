/**
 * dsh-file-attach — host half.
 *
 * A Typert Remote service (`attachUpload` namespace) that receives chunked
 * file uploads from the browser composer paperclip button, stores them inside
 * the session workspace under `.dsh-attachments/<yyyy-MM>/` (falling back to
 * `$DSH_HOME/attachments/files` when the session has no cwd), and returns the
 * absolute path plus a best-effort UTF-8 text preview (md/json/txt/csv raw
 * text; docx/xlsx/pptx unzipped XML text; pdf Flate streams) so the model can
 * recognise the content of the attachment. ANY file type is accepted.
 *
 * Wire contract (SRC mode): the Gateway discovers the `@Remote`-marked
 * methods at runtime; the typert-loader manifest in ./typert.host.js
 * registers the same endpoints for builds without SRC discovery. Parameter
 * names are the wire field names — the client half's descriptors must keep
 * the same names and order.
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { unzipSync } from 'fflate'
import { inflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, extname, join } from 'node:path'

/** @Remote-marked public methods: [method, exportName]. */
const REMOTE_METHODS = [
  ['beginUpload', 'beginUpload'],
  ['uploadChunk', 'uploadChunk'],
  ['finishUpload', 'finishUpload'],
  ['abortUpload', 'abortUpload'],
]

// ──── admission policy ────

const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'amr', 'opus', 'ape'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'ts', 'mpg', 'mpeg', '3gp'])
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'odt', 'ods', 'odp', 'rtf'])
const TEXT_EXT = new Set(['md', 'markdown', 'json', 'txt'])
const PDF_EXT = new Set(['pdf'])

/** Maximum accepted upload size: 1 GiB. */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
/** Raw bytes per chunk (base64 rides the JSON RPC wire). */
const CHUNK_BYTES = 4 * 1024 * 1024
/** Uploads with no chunk activity older than this are cleaned on next begin. */
const STALE_UPLOAD_MS = 2 * 60 * 60 * 1000

/** Classify a file name into an attachment kind; unknown extensions are 'file'. */
function classify(name) {
  const ext = extname(String(name || '')).replace(/^\./, '').toLowerCase()
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (PDF_EXT.has(ext)) return 'pdf'
  if (OFFICE_EXT.has(ext)) return 'office'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'file'
}

/** Strip path separators / control characters and cap length. */
function sanitizeName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150)
  if (!cleaned) return 'attachment'
  if (!extname(cleaned) && classify(cleaned) !== null) return cleaned
  return cleaned
}

function monthDirName() {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${mm}`
}

// ──── best-effort text previews ────

const PREVIEW_TEXT_MAX = 6000
const PREVIEW_EXTRACT_MAX = 4000

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** Strip XML tags and decode entities, preserving nothing structural. */
function xmlText(xml) {
  const withoutTags = String(xml).replace(/<[^>]*>/g, ' ')
  return collapse(decodeEntities(withoutTags))
}

/** Collect every <t> text node of one XML document (shared strings / slides). */
function collectTTexts(xml) {
  const out = []
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const text = decodeEntities(m[1]).replace(/\s+/g, ' ')
    if (text) out.push(text)
  }
  return out
}

function capPreview(text, max) {
  const trimmed = String(text || '').trim()
  if (trimmed.length <= max) return { preview: trimmed, truncated: false }
  return { preview: trimmed.slice(0, max), truncated: true }
}

/** Extract a text preview from the stored file. Never throws. */
function extractPreview(name, kind, filePath) {
  try {
    if (kind === 'text') {
      let raw = readFileSync(filePath, 'utf8')
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
      return capPreview(raw, PREVIEW_TEXT_MAX)
    }
    if (kind === 'pdf') return extractPdfPreview(filePath)
    if (kind === 'office') return extractOfficePreview(name, filePath)
    return { preview: null, truncated: false }
  } catch {
    return { preview: null, truncated: false }
  }
}

/** Minimal pure-JS PDF text pull: Flate-decode streams, then Tj/TJ strings. */
function extractPdfPreview(filePath) {
  const buf = readFileSync(filePath)
  const parts = []
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g
  let m
  while ((m = streamRe.exec(buf.toString('latin1'))) !== null) {
    let data
    try {
      data = inflateSync(Buffer.from(m[1], 'latin1'))
    } catch {
      data = Buffer.from(m[1], 'latin1')
    }
    let text = ''
    const strRe = /\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|TJ)/g
    let s
    const latin = data.toString('latin1')
    while ((s = strRe.exec(latin)) !== null) {
      text += decodePdfString(s[1]) + ' '
    }
    if (text.trim()) parts.push(collapse(text))
  }
  if (parts.length === 0) return { preview: null, truncated: false }
  return capPreview(parts.join(' '), PREVIEW_EXTRACT_MAX)
}

function decodePdfString(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      const next = raw[i + 1]
      if (next === undefined) break
      if (next === 'n') { out += '\n'; i += 1; continue }
      if (next === 'r') { out += '\r'; i += 1; continue }
      if (next === 't') { out += '\t'; i += 1; continue }
      if (next === 'b') { out += '\b'; i += 1; continue }
      if (next === 'f') { out += '\f'; i += 1; continue }
      if (next >= '0' && next <= '7') {
        const oct = raw.slice(i + 1, i + 4)
        if (/^[0-7]{1,3}$/.test(oct)) {
          out += String.fromCharCode(Number.parseInt(oct, 8))
          i += oct.length
          continue
        }
      }
      out += next
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/** docx / xlsx / pptx are ZIP containers of XML: unzip and pull the text. */
function extractOfficePreview(name, filePath) {
  const ext = extname(name).replace(/^\./, '').toLowerCase()
  const buf = readFileSync(filePath)
  let entries
  try {
    entries = unzipSync(new Uint8Array(buf))
  } catch {
    return { preview: null, truncated: false }
  }
  const entry = (key) => {
    const found = Object.keys(entries).find((k) => k === key || k.endsWith('/' + key))
    return found === undefined ? null : entries[found]
  }
  const textOf = (key) => {
    const bytes = entry(key)
    if (bytes === null) return ''
    return xmlText(Buffer.from(bytes).toString('utf8'))
  }
  if (ext === 'docx') {
    const body = textOf('word/document.xml')
    if (!body) return { preview: null, truncated: false }
    return capPreview(body, PREVIEW_EXTRACT_MAX)
  }
  if (ext === 'pptx') {
    const slides = Object.keys(entries)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => Number.parseInt(a.match(/slide(\d+)/)[1], 10) - Number.parseInt(b.match(/slide(\d+)/)[1], 10))
    const parts = []
    for (const key of slides) {
      const texts = collectTTexts(Buffer.from(entries[key]).toString('utf8'))
      if (texts.length > 0) parts.push(`[幻灯片 ${parts.length + 1}] ${texts.join(' ')}`)
    }
    if (parts.length === 0) return { preview: null, truncated: false }
    return capPreview(parts.join(' | '), PREVIEW_EXTRACT_MAX)
  }
  if (ext === 'xlsx') {
    const parts = []
    const shared = entry('xl/sharedStrings.xml')
    if (shared !== null) {
      const texts = collectTTexts(Buffer.from(shared).toString('utf8'))
      parts.push('共享字符串: ' + texts.join(' '))
    }
    const sheets = Object.keys(entries)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => Number.parseInt(a.match(/sheet(\d+)/)[1], 10) - Number.parseInt(b.match(/sheet(\d+)/)[1], 10))
    for (const key of sheets) {
      const texts = collectTTexts(Buffer.from(entries[key]).toString('utf8'))
      if (texts.length > 0) parts.push(`[工作表 ${parts.length}] ${texts.join(' | ')}`)
    }
    if (parts.length === 0) return { preview: null, truncated: false }
    return capPreview(parts.join(' '), PREVIEW_EXTRACT_MAX)
  }
  // Legacy binary Office (doc/xls/ppt), csv, rtf, odt等: no pure-JS pull.
  if (ext === 'csv') {
    let raw = readFileSync(filePath, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    return capPreview(raw, PREVIEW_EXTRACT_MAX)
  }
  return { preview: null, truncated: false }
}

// ──── remote service ────

export class AttachUploadGateway extends TypertRemoteService {
  /** uploadId -> in-flight upload record. */
  uploads = new Map()

  constructor(ctx) {
    super(ctx, 'attachUpload')
    // SRC-mode discovery markers (idempotent per prototype).
    const initializers = []
    for (const [method, exportName] of REMOTE_METHODS) {
      const context = {
        kind: 'method',
        name: method,
        static: false,
        private: false,
        access: {},
        addInitializer(fn) { initializers.push(fn) },
      }
      Remote(exportName)(this.constructor.prototype[method], context)
    }
    for (const fn of initializers) fn.call(this)
  }

  stagingRoot() {
    return join(this.attachmentsRoot(), '.uploads')
  }

  attachmentsRoot() {
    return dshHomePath('attachments', 'files')
  }

  /** The session's workspace when it has a cwd, else the DSH attachments root. */
  sessionRoot(sessionId) {
    try {
      const sessions = this.ctx.get('sessions')
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return join(cwd, '.dsh-attachments')
    } catch {
      /* fall through to the durable home root */
    }
    return this.attachmentsRoot()
  }

  cleanupStaleUploads() {
    try {
      const root = this.stagingRoot()
      if (!existsSync(root)) return
      const now = Date.now()
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        try {
          if (now - statSync(dir).mtimeMs > STALE_UPLOAD_MS) rmSync(dir, { recursive: true, force: true })
        } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  /** Find a non-colliding destination path inside `dir` for `name`. */
  uniqueDest(dir, name) {
    const ext = extname(name)
    const stem = basename(name, ext)
    let candidate = join(dir, name)
    let index = 1
    while (existsSync(candidate)) {
      candidate = join(dir, `${stem}-${index}${ext}`)
      index += 1
    }
    return candidate
  }

  async beginUpload(sessionId, name, size) {
    try {
      const safeName = sanitizeName(name)
      const kind = classify(safeName)
      const numericSize = Number(size)
      if (!Number.isFinite(numericSize) || numericSize <= 0) return { ok: false, message: '文件大小无效' }
      if (numericSize > MAX_UPLOAD_BYTES) return { ok: false, message: `文件过大(上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` }
      this.cleanupStaleUploads()
      const uploadId = randomUUID()
      const sessionRoot = this.sessionRoot(String(sessionId || ''))
      const monthDir = join(sessionRoot, monthDirName())
      const staging = join(this.stagingRoot(), uploadId)
      mkdirSync(staging, { recursive: true })
      this.uploads.set(uploadId, {
        sessionId: String(sessionId || ''),
        name: safeName,
        kind,
        size: numericSize,
        staging,
        monthDir,
        received: 0,
      })
      return { ok: true, uploadId, kind }
    } catch (err) {
      return { ok: false, message: `开始上传失败:${String(err?.message || err)}` }
    }
  }

  async uploadChunk(uploadId, index, data) {
    try {
      const record = this.uploads.get(String(uploadId))
      if (record === undefined) return { ok: false, message: '上传会话不存在或已过期' }
      const chunkIndex = Number(index)
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex !== record.received) {
        return { ok: false, message: `分片序号错误:期望 ${record.received},收到 ${chunkIndex}` }
      }
      if (chunkIndex * CHUNK_BYTES >= record.size) {
        return { ok: false, message: '分片超过文件大小' }
      }
      const payload = String(data || '')
      if (!/^[A-Za-z0-9+/=\s]+$/.test(payload) || payload.length === 0) {
        return { ok: false, message: '分片数据格式错误' }
      }
      const buffer = Buffer.from(payload, 'base64')
      if (buffer.length === 0) return { ok: false, message: '分片内容为空' }
      const partFile = join(record.staging, 'part.bin')
      appendFileSync(partFile, buffer)
      record.received += 1
      return { ok: true, received: record.received }
    } catch (err) {
      return { ok: false, message: `写入分片失败:${String(err?.message || err)}` }
    }
  }

  async finishUpload(uploadId) {
    const record = this.uploads.get(String(uploadId))
    if (record === undefined) return { ok: false, message: '上传会话不存在或已过期' }
    try {
      const partFile = join(record.staging, 'part.bin')
      if (!existsSync(partFile)) {
        rmSync(record.staging, { recursive: true, force: true })
        this.uploads.delete(String(uploadId))
        return { ok: false, message: '没有收到任何数据分片' }
      }
      if (statSync(partFile).size < record.size) {
        rmSync(record.staging, { recursive: true, force: true })
        this.uploads.delete(String(uploadId))
        return { ok: false, message: `文件不完整:已收到 ${statSync(partFile).size} 字节,期望 ${record.size} 字节` }
      }
      mkdirSync(record.monthDir, { recursive: true })
      const dest = this.uniqueDest(record.monthDir, record.name)
      try {
        renameSync(partFile, dest)
      } catch (err) {
        // Staging lives on the DSH home volume while the session workspace may
        // be on another drive: renameSync then fails with EXDEV. Copy and drop
        // the staging part instead — same durability, no cross-device limit.
        if (err?.code !== 'EXDEV') throw err
        copyFileSync(partFile, dest)
        rmSync(partFile, { force: true })
      }
      rmSync(record.staging, { recursive: true, force: true })
      this.uploads.delete(String(uploadId))
      const { preview, truncated } = extractPreview(record.name, record.kind, dest)
      return {
        ok: true,
        path: dest,
        name: record.name,
        size: record.size,
        kind: record.kind,
        preview: preview === null ? null : preview,
        previewTruncated: truncated,
      }
    } catch (err) {
      try { rmSync(record.staging, { recursive: true, force: true }) } catch { /* best effort */ }
      this.uploads.delete(String(uploadId))
      return { ok: false, message: `合并文件失败:${String(err?.message || err)}` }
    }
  }

  async abortUpload(uploadId) {
    const record = this.uploads.get(String(uploadId))
    if (record === undefined) return { ok: true }
    try {
      rmSync(record.staging, { recursive: true, force: true })
    } catch { /* best effort */ }
    this.uploads.delete(String(uploadId))
    return { ok: true }
  }
}

export default AttachUploadGateway
export { classify, sanitizeName, extractPreview, humanReadableSize }

/** Human-readable byte size (exported for client-facing diagnostics). */
function humanReadableSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
