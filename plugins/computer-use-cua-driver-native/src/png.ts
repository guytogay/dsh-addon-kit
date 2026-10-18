/**
 * Zero-dependency PNG decoding and luminance grids (TS port of reference/png.mjs).
 *
 * An exact hash of the PNG bytes is not a usable "did the pixels move" signal: a blinking caret or
 * an overlay repaints a few pixels and an exact hash calls a quiet window busy. So the window is
 * sampled into a coarse grid and compared with statistics instead. Kept in step with
 * reference/png.mjs by the same fixtures; if you change one, change both.
 */
import { inflateSync } from 'node:zlib'


const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/**
 * Decode a PNG into raw 8-bit samples.
 * @param {Uint8Array|Buffer} bytes - the whole PNG file.
 * @returns {{width: number, height: number, channels: number, data: Uint8Array}}
 */
export function decodePng(bytes: Uint8Array | Buffer): { width: number; height: number; channels: number; data: Uint8Array } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG (bad signature)')
  }
  let offset = 8
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | undefined
  const idat: Buffer[] = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8] ?? 0,
        colorType: body[9] ?? 0,
        interlace: body[12] ?? 0,
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
  }
  if (header === undefined) throw new Error('PNG has no IHDR')
  if (header.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${String(header.bitDepth)}`)
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported')
  const channels = (CHANNELS as Record<number, number>)[header.colorType]
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${String(header.colorType)}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  const data = new Uint8Array(stride * header.height)
  let previous = new Uint8Array(stride)
  let cursor = 0
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[cursor] ?? 0
    cursor += 1
    const line = Uint8Array.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    for (let index = 0; index < stride; index += 1) {
      const current = line[index] ?? 0
      const left = index >= channels ? line[index - channels] ?? 0 : 0
      const up = previous[index] ?? 0
      const upLeft = index >= channels ? previous[index - channels] ?? 0 : 0
      if (filter === 1) line[index] = (current + left) & 0xff
      else if (filter === 2) line[index] = (current + up) & 0xff
      else if (filter === 3) line[index] = (current + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const prediction = left + up - upLeft
        const toLeft = Math.abs(prediction - left)
        const toUp = Math.abs(prediction - up)
        const toUpLeft = Math.abs(prediction - upLeft)
        const pick = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
        line[index] = (current + pick) & 0xff
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${String(filter)}`)
      }
    }
    data.set(line, row * stride)
    previous = line
  }
  return { width: header.width, height: header.height, channels, data }
}

/**
 * Average luminance over a cols x rows grid (0-255 per cell).
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} png - decoded image.
 * @param {number} [cols] - grid columns, default 48.
 * @param {number} [rows] - grid rows, default 27.
 * @returns {number[]} row-major cell luminances.
 */
export function luminanceGrid(png: { width: number; height: number; channels: number; data: Uint8Array }, cols = 48, rows = 27): number[] {
  const cells: number[] = []
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row * png.height) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * png.height) / rows))
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor((col * png.width) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * png.width) / cols))
      let total = 0
      let count = 0
      for (let y = y0; y < Math.min(y1, png.height); y += 1) {
        for (let x = x0; x < Math.min(x1, png.width); x += 1) {
          const at = (y * png.width + x) * png.channels
          const r = png.data[at] ?? 0
          const g = png.channels >= 3 ? png.data[at + 1] ?? 0 : r
          const b = png.channels >= 3 ? png.data[at + 2] ?? 0 : r
          total += 0.2126 * r + 0.7152 * g + 0.0722 * b
          count += 1
        }
      }
      cells.push(count === 0 ? 0 : total / count)
    }
  }
  return cells
}

/** Convenience: PNG bytes straight to a luminance grid. */
export function pngGrid(bytes: Uint8Array | Buffer, cols = 48, rows = 27): number[] {
  return luminanceGrid(decodePng(bytes), cols, rows)
}

/** Mean absolute luminance difference between two grids (0-255), or null when incomparable. */
export function pixelDelta(previous: readonly number[], next: readonly number[]): number | null {
  if (previous.length === 0 || previous.length !== next.length) return null
  let sum = 0
  for (let index = 0; index < previous.length; index += 1) sum += Math.abs((previous[index] ?? 0) - (next[index] ?? 0))
  return Math.round((sum / previous.length) * 100) / 100
}

/** How many cells jumped by `jump` or more: the mean alone averages a small moving object away. */
export function countMovedCells(previous: readonly number[], next: readonly number[], jump = 32): number | null {
  if (previous.length === 0 || previous.length !== next.length) return null
  let moved = 0
  for (let index = 0; index < previous.length; index += 1) {
    if (Math.abs((previous[index] ?? 0) - (next[index] ?? 0)) >= jump) moved += 1
  }
  return moved
}

/** On a 48x27 grid this is the count that separates a moving object from a static window. */
export const MOVED_CELLS_THRESHOLD = 12

/**
 * Coarse two-statistic signature of one grid against the previous sample. Identity alone is the
 * wrong test: a band hash still flips when a caret nudges one cell across a band boundary, while a
 * small moving object can leave the mean delta under any sane tolerance.
 */
export function settleSignature(previous: readonly number[] | undefined, grid: readonly number[]): string {
  if (!Array.isArray(grid) || grid.length === 0) return 'no-grid'
  if (!Array.isArray(previous) || previous.length !== grid.length) return 'first'
  const fraction = changedFraction(previous, grid)
  const delta = pixelDelta(previous, grid) ?? 0
  // Measured 2026-10-19 on a 1568x1291 window: a rotating spinner changed 0.30% of pixels, a
  // *focused* blinking caret 0.0145%. Thresholds sit between them; jitter is diagnostic only and
  // must not count as motion, or a caret would never settle.
  const movedBucket = fraction >= 0.001 ? 'moving' : fraction >= 0.0005 ? 'jitter' : 'still'
  const deltaBucket = delta >= 2 ? 'big' : delta >= 0.5 ? 'small' : 'flat'
  return `${movedBucket}/${deltaBucket}`
}

/** Fraction of samples whose luminance moved by `jump` or more (0-1); 0 when incomparable. */
export function changedFraction(previous: readonly number[], next: readonly number[], jump = 24): number {
  if (previous.length === 0 || previous.length !== next.length) return 0
  let changed = 0
  for (let index = 0; index < previous.length; index += 1) {
    if (Math.abs((previous[index] ?? 0) - (next[index] ?? 0)) >= jump) changed += 1
  }
  return changed / previous.length
}

/** Analysis resolution for motion: fine enough that a caret stays under the fraction threshold. */
export const ANALYSIS_COLS = 384
export const ANALYSIS_ROWS = 216

/** Luminance at the analysis resolution, for frame-to-frame change fractions. */
export function analysisLuma(bytes: Uint8Array | Buffer, cols = ANALYSIS_COLS, rows = ANALYSIS_ROWS): number[] {
  return pngGrid(bytes, cols, rows)
}
