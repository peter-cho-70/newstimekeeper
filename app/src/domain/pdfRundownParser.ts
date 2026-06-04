import type { Rundown, RundownItem } from './types'
import { addSecondsToClock, parseTimeToSeconds } from './time'
import { uid } from './uid'
import { mergeCueTokens, extractPdfPageTokens } from './pdfExtract'
import { insertVisualBlankSeparators } from './rundownLayout'

const ICON_RE = /[\uE000-\uF8FF]/u
const TIME_RE = /^\d{2}:\d{2}$/

function isTimeToken(t: string): boolean {
  return TIME_RE.test(t)
}

function isRowNumber(t: string): boolean {
  const n = Number(t)
  return /^\d{1,2}$/.test(t) && n >= 1 && n <= 99
}

function isIconToken(t: string): boolean {
  return ICON_RE.test(t)
}

function isReporterToken(t: string): boolean {
  if (t === '날씨' || t === '타이틀' || t.startsWith('[') || t.startsWith('전') || t.startsWith('오프닝')) {
    return false
  }
  return /^[가-힣]{2,4}$/.test(t) && !isTimeToken(t)
}

function stripIcons(s: string): string {
  return s.replace(ICON_RE, '').replace(/\s+/g, ' ').trim()
}

function detectCategory(icons: string, title: string, durationSeconds: number): string {
  if (title === '타이틀' || title.startsWith('전 CM') || title.startsWith('오프닝')) return ''
  if (title === '날씨') return '단신'
  if (icons.includes('\uE00B')) return '단신'
  if (durationSeconds > 0 && durationSeconds <= 35 && !title) return '단신'
  if (icons.includes('\uE007') || icons.includes('\uE008')) return '완제'
  if (title && (icons.includes('\uE007') || icons.includes('\uE008') || !icons)) return '완제'
  if (icons.includes('\uE006')) return ''
  return title ? '완제' : '단신'
}

type RawRow = {
  title: string
  reporter: string
  durationSeconds: number
  cumulativeSeconds: number | null
  notes: string
  category: string
  sectionTitle: string | null
  isClosing: boolean
}

function isNumberedRowStart(tokens: string[], i: number): boolean {
  if (!isRowNumber(tokens[i] ?? '')) return false
  const next = tokens[i + 1]
  if (!next) return false
  return isIconToken(next) || next.startsWith('[') || isTimeToken(next)
}

function isPreRowStart(tokens: string[], i: number): boolean {
  const t = tokens[i]
  if (!t) return false
  if (t === '타이틀') return true
  if (isIconToken(t) && tokens[i + 1] === '전') return true
  if (isIconToken(t) && tokens[i + 1] === '오프닝') return true
  if (isIconToken(t) && tokens[i + 1] === '이') return true
  return false
}

function isSpecialStart(tokens: string[], i: number): 'cm_after' | 'closing' | 'server' | null {
  if (tokens[i] === '후' && tokens[i + 1] === 'CM') return 'cm_after'
  if (tokens[i] === '클로징') return 'closing'
  if (tokens[i] === '서버' && tokens[i + 1] === '영상') return 'server'
  return null
}

function rowIsComplete(chunk: string[], numbered: boolean): boolean {
  const times = chunk.filter(isTimeToken)
  if (times.length < 2) return false
  if (numbered) {
    const hasReporter = chunk.some((t, idx) => isReporterToken(t) && isTimeToken(chunk[idx + 1] ?? ''))
    const onlyTimes = chunk.filter((t) => isTimeToken(t) || isRowNumber(t) || isIconToken(t)).length >= chunk.length - 1
    return hasReporter || onlyTimes
  }
  return true
}

function segmentTokenRows(tokens: string[]): string[][] {
  const rows: string[][] = []
  let i = 0

  while (i < tokens.length) {
    const special = isSpecialStart(tokens, i)
    if (special === 'cm_after') {
      rows.push(['후', 'CM', '없음'])
      i += 3
      continue
    }
    if (special === 'server') {
      rows.push(['서버', '영상', '자료'])
      i += 3
      continue
    }
    if (special === 'closing') {
      const chunk: string[] = []
      while (i < tokens.length) {
        chunk.push(tokens[i]!)
        i++
        if (rowIsComplete(chunk, false)) {
          while (i < tokens.length && !isNumberedRowStart(tokens, i) && !isPreRowStart(tokens, i) && !isSpecialStart(tokens, i)) {
            const t = tokens[i]
            if (t && (isNumberedRowStart(tokens, i) || t === '서버' || t === '')) break
            if (isIconToken(t ?? '') && tokens[i + 1] === '서버') break
            chunk.push(tokens[i]!)
            i++
          }
          break
        }
      }
      rows.push(chunk)
      continue
    }

    if (isNumberedRowStart(tokens, i)) {
      const chunk: string[] = [tokens[i]!]
      i++
      while (i < tokens.length) {
        if (rowIsComplete(chunk, true) && isNumberedRowStart(tokens, i)) break
        if (rowIsComplete(chunk, true) && isSpecialStart(tokens, i)) break
        if (rowIsComplete(chunk, true) && isPreRowStart(tokens, i)) break
        chunk.push(tokens[i]!)
        i++
        if (rowIsComplete(chunk, true)) {
          const next = tokens[i]
          if (
            next != null &&
            (isNumberedRowStart(tokens, i) ||
              isSpecialStart(tokens, i) ||
              (isIconToken(next) && tokens[i + 1] === '서버'))
          ) {
            break
          }
        }
      }
      rows.push(chunk)
      continue
    }

    if (isPreRowStart(tokens, i)) {
      const chunk: string[] = []
      while (i < tokens.length) {
        chunk.push(tokens[i]!)
        i++
        if (rowIsComplete(chunk, false)) {
          while (i < tokens.length) {
            if (isNumberedRowStart(tokens, i) || isSpecialStart(tokens, i) || isPreRowStart(tokens, i)) break
            chunk.push(tokens[i]!)
            i++
          }
          break
        }
      }
      rows.push(chunk)
      continue
    }

    i++
  }

  return rows
}

function parseChunk(chunk: string[]): RawRow | null {
  if (chunk.length === 0) return null
  if (chunk[0] === '후' && chunk[1] === 'CM') {
    return {
      title: '',
      reporter: '',
      durationSeconds: 0,
      cumulativeSeconds: null,
      notes: '',
      category: '',
      sectionTitle: '후 CM 없음',
      isClosing: false,
    }
  }
  if (chunk[0] === '서버') {
    return {
      title: '',
      reporter: '',
      durationSeconds: 0,
      cumulativeSeconds: null,
      notes: '',
      category: '',
      sectionTitle: '서버 영상 자료',
      isClosing: false,
    }
  }

  const icons = chunk.filter(isIconToken).join('')
  const times = chunk.filter(isTimeToken)
  let durationSeconds = 0
  let cumulativeSeconds: number | null = null
  if (times.length >= 2) {
    durationSeconds = parseTimeToSeconds(times[times.length - 2]!) ?? 0
    cumulativeSeconds = parseTimeToSeconds(times[times.length - 1]!)
  } else if (times.length === 1) {
    durationSeconds = parseTimeToSeconds(times[0]!) ?? 0
  }

  const isClosing = chunk[0] === '클로징' || chunk.join(' ').includes('클로징')
  if (isClosing) {
    const notesParts: string[] = []
    let timeSeen = 0
    for (const t of chunk) {
      if (isTimeToken(t)) {
        timeSeen++
        continue
      }
      if (timeSeen >= 2) notesParts.push(t)
    }
    return {
      title: '클로징 / 아이엠뉴스 / 끝 타…',
      reporter: '',
      durationSeconds,
      cumulativeSeconds,
      notes: notesParts.join(' ').trim() || '끝',
      category: '',
      sectionTitle: null,
      isClosing: true,
    }
  }

  const lineNo = isRowNumber(chunk[0] ?? '') ? Number(chunk[0]) : null
  const firstTimeIdx = chunk.findIndex(isTimeToken)
  let reporterIdx = -1
  const bodyStart = lineNo != null ? 1 : 0
  for (let j = bodyStart; j < chunk.length; j++) {
    if (firstTimeIdx >= 0 && j >= firstTimeIdx) break
    if (!isReporterToken(chunk[j]!) || !isTimeToken(chunk[j + 1] ?? '')) continue
    const titleBefore = chunk
      .slice(bodyStart, j)
      .filter((t) => !isIconToken(t) && !isRowNumber(t) && !isTimeToken(t))
    if (titleBefore.length > 0) {
      reporterIdx = j
      break
    }
  }

  const reporter = reporterIdx >= 0 ? chunk[reporterIdx]! : ''
  const titleParts: string[] = []
  const notesParts: string[] = []

  for (let j = 0; j < chunk.length; j++) {
    const t = chunk[j]!
    if (lineNo != null && j === 0) continue
    if (isIconToken(t)) continue
    if (j === reporterIdx) continue
    if (isTimeToken(t)) continue
    const timeCount = chunk.slice(0, j).filter(isTimeToken).length
    if (firstTimeIdx >= 0 && timeCount >= 2 && j > firstTimeIdx) {
      notesParts.push(t)
      continue
    }
    if (firstTimeIdx >= 0 && j > firstTimeIdx && timeCount >= 1 && reporterIdx < 0) {
      notesParts.push(t)
      continue
    }
    if (j !== reporterIdx) titleParts.push(t)
  }

  let title = stripIcons(titleParts.join(' '))
  if (title === '타이틀') {
    // keep
  } else if (title.startsWith('전 CM')) {
    // keep full
  } else if (title.startsWith('오프닝')) {
    // keep
  }

  let notes = stripIcons(notesParts.join(' '))
  let reporterOut = reporter
  if (!reporterOut && notes && title.startsWith('오프닝')) {
    const parts = notes.split(/\s+/).filter(Boolean)
    if (parts[0] && /^[가-힣]{2,5}$/.test(parts[0])) {
      reporterOut = parts[0]
      notes = parts.slice(1).join(' ')
    }
  }

  if (!title && lineNo != null) title = `예비 ${lineNo}번`

  const category = detectCategory(icons, title, durationSeconds)

  if (!title && durationSeconds === 0 && lineNo == null) return null

  return {
    title,
    reporter: reporterOut,
    durationSeconds,
    cumulativeSeconds,
    notes,
    category,
    sectionTitle: null,
    isClosing: false,
  }
}

function sumIncludedSeconds(items: RundownItem[]): number {
  let total = 0
  let afterEnd = false
  for (const it of items) {
    if (it.kind === 'marker' && it.title === '뉴스끝') afterEnd = true
    if (afterEnd) continue
    if ((it.kind === 'newsItem' || it.kind === 'sectionHeader') && it.includeInRun) {
      total += it.durationSeconds
    }
  }
  return total
}

export type PdfParseMeta = {
  programTitle: string
  broadcastDate: string
  scheduledSeconds: number
  anchorName: string
  pdName: string
  episodeLabel: string
}

function parseMetaFromTokens(allPageTokens: string[][]): PdfParseMeta {
  const flat = allPageTokens.flat().join('\t')
  const programMatch = flat.match(/MBC\s+([^(\t]+?)(?:\((\d{4}-\d{2}-\d{2})\))?/)
  const programTitle = programMatch?.[1]?.trim() ?? 'PDF 큐시트'
  const broadcastDate = programMatch?.[2] ?? new Date().toISOString().slice(0, 10)
  const minMatch = programTitle.match(/(\d+)\s*분간/)
  const scheduledSeconds = minMatch ? Number(minMatch[1]) * 60 : 21 * 60
  const ancMatch = flat.match(/ANC:\s*([가-힣]+)/)
  const pdMatch = flat.match(/PD:\s*([가-힣]+)/)
  return {
    programTitle,
    broadcastDate,
    scheduledSeconds,
    anchorName: ancMatch?.[1] ?? '',
    pdName: pdMatch?.[1] ?? '',
    episodeLabel: programTitle,
  }
}

function guessProgramId(programTitle: string): string {
  if (/12\s*뉴스|12뉴스/i.test(programTitle)) return 'news_12'
  if (/930/i.test(programTitle)) return 'news_930'
  if (/25|뉴스25/i.test(programTitle)) return 'news_25'
  if (/데스크/i.test(programTitle)) return 'news_desk'
  if (/외전/i.test(programTitle)) return 'news_extra'
  if (/경제/i.test(programTitle)) return 'news_economy'
  return 'news_12'
}

const PROGRAM_NAMES: Record<string, string> = {
  news_12: '12시뉴스',
  news_930: '930뉴스',
  news_25: '뉴스25',
  news_desk: '뉴스데스크',
  news_extra: '뉴스외전',
  news_economy: '뉴스와 경제',
}

function rawRowsToItems(rows: RawRow[]): RundownItem[] {
  const items: RundownItem[] = []
  let pastClosing = false
  let closingCumulative = 0

  for (const row of rows) {
    if (row.sectionTitle) {
      items.push({
        id: uid('s_'),
        kind: 'sectionHeader',
        title: row.sectionTitle,
        durationSeconds: 0,
        includeInRun: false,
      })
      continue
    }

    if (row.isClosing) {
      pastClosing = true
      closingCumulative = row.cumulativeSeconds ?? 0
      items.push({
        id: uid('i_'),
        kind: 'newsItem',
        category: '',
        reporter: '',
        title: row.title,
        durationSeconds: row.durationSeconds,
        notes: row.notes,
        isDefaultItem: false,
        isEmphasis: false,
        isTimeAdjust: false,
        includeInRun: true,
        flags: [],
      })
      continue
    }

    const pastMainEnd =
      pastClosing ||
      (closingCumulative > 0 && row.cumulativeSeconds != null && row.cumulativeSeconds > closingCumulative)

    items.push({
      id: uid('i_'),
      kind: 'newsItem',
      category: row.category,
      reporter: row.reporter,
      title: row.title,
      durationSeconds: row.durationSeconds,
      notes: row.notes,
      isDefaultItem: false,
      isEmphasis: false,
      isTimeAdjust: false,
      includeInRun: row.durationSeconds > 0 ? true : !pastMainEnd,
      flags: [],
    })
  }

  const endIdx = items.findIndex((x) => x.kind === 'newsItem' && x.title.includes('클로징'))
  const marker: RundownItem = { id: uid('m_'), kind: 'marker', title: '뉴스끝', includeInRun: false }

  let merged: RundownItem[]
  if (endIdx >= 0) {
    const before = items.slice(0, endIdx + 1)
    const after = items.slice(endIdx + 1)
    merged = [...before, marker, ...after]
  } else {
    merged = [...items, marker]
  }

  return insertVisualBlankSeparators(merged)
}

export async function parsePdfToRundown(
  file: File,
  opts: { programId?: string; programName?: string } = {},
): Promise<Rundown> {
  const pages = await extractPdfPageTokens(file)
  const meta = parseMetaFromTokens(pages)
  const tokens = mergeCueTokens(pages)
  const chunks = segmentTokenRows(tokens)
  const rawRows = chunks.map(parseChunk).filter((r): r is RawRow => r != null)

  if (rawRows.length === 0) {
    throw new Error('PDF에서 큐시트 행을 찾지 못했습니다. MBC 뉴스 큐시트 PDF인지 확인해 주세요.')
  }

  const programId = opts.programId ?? guessProgramId(meta.programTitle)
  const programName = opts.programName ?? PROGRAM_NAMES[programId] ?? meta.programTitle

  const items = rawRowsToItems(rawRows)
  const includedTotal = sumIncludedSeconds(items)
  const newsEndTime = addSecondsToClock('12:00:00', includedTotal) || '12:21:12'

  return {
    schemaVersion: '1.0',
    type: 'rundown',
    programId,
    programName,
    broadcastDate: meta.broadcastDate,
    episodeLabel: [meta.episodeLabel, meta.anchorName ? `ANC:${meta.anchorName}` : '', meta.pdName ? `PD:${meta.pdName}` : '']
      .filter(Boolean)
      .join(' | '),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timing: {
      newsStartTime: '12:00:00',
      scheduledSeconds: meta.scheduledSeconds,
      newsEndTime,
      budgetMode: 'scheduled',
      autoStartAtNewsTime: true,
      toleranceSeconds: 15,
    },
    items,
  }
}
