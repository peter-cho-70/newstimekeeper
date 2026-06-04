import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
).href

const pdfPath = process.argv[2] ?? '/Users/mbp/Downloads/다운로드.pdf'
const data = new Uint8Array(fs.readFileSync(pdfPath))
const pdf = await getDocument({ data, useSystemFonts: true }).promise

const pages: string[][] = []
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p)
  const content = await page.getTextContent()
  const tokens = content.items
    .map((item) => ('str' in item ? String(item.str) : ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  pages.push(tokens)
}

// merge like pdfExtract
const merged: string[] = []
let sawHeader = false
for (const pageTokens of pages) {
  const headerIdx = pageTokens.findIndex((t) => t === '부가자막')
  const start = headerIdx >= 0 ? headerIdx + 1 : 0
  if (sawHeader && headerIdx >= 0) {
    merged.push(...pageTokens.slice(start))
    continue
  }
  if (headerIdx >= 0) sawHeader = true
  merged.push(...pageTokens.slice(start))
}

console.log('merged tokens', merged.length)
console.log('numbered 1-20:', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((n) => {
  const idx = merged.indexOf(String(n))
  return `${n}:${idx >= 0 ? idx : 'MISS'}`
}).join(' '))

const { parsePdfToRundown } = await import('../src/domain/pdfRundownParser.ts')
const file = new File([data], 'test.pdf', { type: 'application/pdf' })
const rd = await parsePdfToRundown(file)
console.log('\nparsed items', rd.items.length)
for (const it of rd.items) {
  if (it.kind === 'blank') console.log('  [blank]')
  else if (it.kind === 'marker') console.log('  [marker]', it.title)
  else if (it.kind === 'sectionHeader') console.log('  [section]', it.title)
  else console.log('  ', it.durationSeconds + 's', it.category || '(구조)', it.title.slice(0, 50))
}
