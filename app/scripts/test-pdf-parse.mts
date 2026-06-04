import fs from 'node:fs'
import { parsePdfToRundown } from '../src/domain/pdfRundownParser.ts'

const buf = fs.readFileSync('/Users/mbp/Downloads/다운로드.pdf')
const file = new File([buf], 'test.pdf', { type: 'application/pdf' })
const rd = await parsePdfToRundown(file)
console.log('items', rd.items.length)
console.log('scheduled', rd.timing.scheduledSeconds)
const blanks = rd.items.filter((i) => i.kind === 'blank').length
console.log('blanks', blanks)
for (const it of rd.items) {
  if (it.kind === 'blank') console.log('___ blank')
  else if (it.kind === 'newsItem') {
    const inc = it.includeInRun ? '+' : '-'
    console.log(inc, it.category.padEnd(4), String(it.durationSeconds).padStart(5) + 's', it.title.slice(0, 40))
  } else console.log('---', it.kind, it.title)
}
