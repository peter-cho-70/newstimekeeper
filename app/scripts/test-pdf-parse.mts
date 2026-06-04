import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
).href

const pdfPath = process.argv[2] ?? '/Users/mbp/Downloads/다운로드.pdf'
const { parsePdfToRundown } = await import('../src/domain/pdfRundownParser.ts')

const buf = fs.readFileSync(pdfPath)
const file = new File([buf], pdfPath.split('/').pop() ?? 'test.pdf', { type: 'application/pdf' })
const rd = await parsePdfToRundown(file)

console.log('file', pdfPath)
console.log('program', rd.programId, rd.programName, 'items', rd.items.length)
console.log('scheduled', rd.timing.scheduledSeconds, 'start', rd.timing.newsStartTime)
const cats = new Map<string, number>()
for (const it of rd.items) {
  if (it.kind === 'newsItem') cats.set(it.category, (cats.get(it.category) ?? 0) + 1)
}
console.log('categories', Object.fromEntries(cats))
console.log('---')
let pastEnd = false
for (const it of rd.items) {
  if (it.kind === 'marker' && it.title === '뉴스끝') {
    pastEnd = true
    console.log('  [marker] 뉴스끝')
    continue
  }
  const spareTag = pastEnd && it.kind === 'newsItem' && it.flags.includes('spare') ? ' spare' : ''
  if (it.kind === 'blank') console.log('  [blank]')
  else if (it.kind === 'newsItem') {
    console.log(
      ' ',
      String(it.cueNo ?? '-').padStart(3),
      it.category.padEnd(6),
      String(it.durationSeconds).padStart(5) + 's',
      it.title.slice(0, 45) + spareTag,
    )
  } else console.log('  [' + it.kind + ']' + (pastEnd ? ' afterEnd' : ''), it.title)
}
const spareN = rd.items.filter((it) => it.kind === 'newsItem' && it.flags.includes('spare')).length
console.log('spare items (after 뉴스끝):', spareN)
