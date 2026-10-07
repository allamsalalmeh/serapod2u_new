import { inflateRawSync } from 'node:zlib'

/**
 * Minimal .xlsx reader for marketplace exports (server only).
 *
 * TikTok Seller Center writes every cell in its own <row> element, which
 * exceljs collapses to the last cell of each row, so cells are placed by their
 * A1 reference here. Shared strings, inline strings and plain values are read
 * as text; nothing is evaluated.
 */

export interface XlsxSheet {
  name: string
  rows: string[][]
}

const MAX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const minEocd = Math.max(0, buffer.length - 65557)
  let eocd = -1
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not an Excel (.xlsx) file')

  const entries = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const files = new Map<string, Buffer>()
  let total = 0
  for (let n = 0; n < entries; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Damaged Excel file')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    if (!/^(xl\/|\[Content_Types\])/.test(name) || name.endsWith('/')) continue
    total += size
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('Excel file is too large')
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Damaged Excel file')
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const data = buffer.subarray(start, start + compressedSize)
    if (method === 0) files.set(name, Buffer.from(data))
    else if (method === 8) files.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }))
    else throw new Error('Unsupported Excel compression')
  }
  return files
}

function decodeXml(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attr(attrs: string, name: string) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))
  return m ? decodeXml(m[1]) : null
}

function textRuns(xml: string) {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('')
}

function columnIndex(letters: string) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const grid: string[][] = []
  let row = -1
  let col = -1
  for (const m of xml.matchAll(/<row\b([^>]*)>|<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (m[1] !== undefined) {
      const r = attr(m[1], 'r')
      row = r ? Number(r) - 1 : row + 1
      col = -1
      continue
    }
    const attrs = m[2] || ''
    const ref = attr(attrs, 'r')?.match(/^([A-Z]+)(\d+)$/)
    if (ref) { col = columnIndex(ref[1]); row = Number(ref[2]) - 1 } else { col += 1 }
    if (row < 0) continue
    const inner = m[3] || ''
    const type = attr(attrs, 't')
    const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
    let value = ''
    if (type === 's') value = shared[Number(raw)] ?? ''
    else if (type === 'inlineStr') value = textRuns(inner)
    else if (raw !== undefined) value = decodeXml(raw)
    ;(grid[row] ||= [])[col] = value.trim()
  }
  const width = grid.reduce((w, r) => Math.max(w, r ? r.length : 0), 0)
  return Array.from(grid, r => Array.from({ length: width }, (_, i) => r?.[i] ?? ''))
}

export function readXlsx(buffer: Buffer): XlsxSheet[] {
  const files = readZipEntries(buffer)
  const text = (name: string) => files.get(name)?.toString('utf8') ?? ''
  const workbook = text('xl/workbook.xml')
  if (!workbook) throw new Error('Not an Excel (.xlsx) file')

  const rels = new Map<string, string>()
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id')
    const target = attr(m[1], 'Target')
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textRuns(m[1]))

  const sheets: XlsxSheet[] = []
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name') || ''
    const path = rels.get(attr(m[1], 'r:id') || '')
    const xml = path ? text(path) : ''
    sheets.push({ name, rows: xml ? parseSheet(xml, shared) : [] })
  }
  return sheets
}
