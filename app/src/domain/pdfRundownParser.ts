import type { Rundown, RundownItem } from './types'
import { addSecondsToClock, parseTimeToSeconds } from './time'
import { uid } from './uid'
import { mergeCueTokens, extractPdfPageTokens } from './pdfExtract'
import { insertVisualBlankSeparators } from './rundownLayout'
import {
  ANCHOR_BLANK_DURATION,
  CATEGORY_BLANK,
  defaultDurationForBlankSlot,
  normalizeNewsCategory,
} from './cueCategories'

const ICON_RE = /[\uE000-\uF8FF]/u
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/

const MAX_ITEM_DURATION_SEC = 900 // 15분 — 그 이상이면 누적시각으로 간주

function isTimeToken(t: string): boolean {
  return TIME_RE.test(t.trim())
}

function isRowNumber(t: string): boolean {
  const n = Number(t)
  return /^\d{1,2}$/.test(t) && n >= 1 && n <= 99
}

function isIconToken(t: string): boolean {
  return ICON_RE.test(t)
}

function isFormatComplete(t: string): boolean {
  return t === '完' || t === 'L' || t === 'LTE'
}

function isReporterToken(t: string): boolean {
  if (
    t === '날씨' ||
    t === '타이틀' ||
    t.startsWith('[') ||
    /^전\s*CM/i.test(t) ||
    t.startsWith('오프닝') ||
    t.startsWith('주요뉴스') ||
    /^단\//.test(t) ||
    t === 'ANC' ||
    t === 'exr'
  ) {
    return false
  }
  return /^[가-힣]{2,4}$/.test(t) && !isTimeToken(t)
}

function stripIcons(s: string): string {
  return s.replace(ICON_RE, '').replace(/\s+/g, ' ').trim()
}

function parseRowTimes(times: string[]): { durationSeconds: number; cumulativeSeconds: number | null } {
  if (times.length === 0) return { durationSeconds: 0, cumulativeSeconds: null }
  const parsed = times.map((t) => parseTimeToSeconds(t) ?? 0)
  if (parsed.length === 1) {
    const v = parsed[0]!
    return v <= MAX_ITEM_DURATION_SEC
      ? { durationSeconds: v, cumulativeSeconds: null }
      : { durationSeconds: 0, cumulativeSeconds: v }
  }
  const durRaw = parsed[parsed.length - 2]!
  const cumRaw = parsed[parsed.length - 1]!
  if (durRaw <= MAX_ITEM_DURATION_SEC) {
    return { durationSeconds: durRaw, cumulativeSeconds: cumRaw }
  }
  if (cumRaw > durRaw && durRaw <= 3600) {
    return { durationSeconds: cumRaw - durRaw, cumulativeSeconds: cumRaw }
  }
  return { durationSeconds: Math.min(durRaw, cumRaw), cumulativeSeconds: cumRaw }
}

function detectCategory(icons: string, title: string, durationSeconds: number, chunk: string[]): string {
  const t = title.trim()
  const flat = chunk.join(' ')

  if (isStructuralTitleToken(t)) {
    if (/^오프닝/i.test(t) || /앵커/.test(t) || /클로징|뉴스25\s*끝/i.test(t)) return CATEGORY_BLANK
    if (/^전\s*CM|^전CM|\d부\s*전CM|^CM\s*\(|^중간광고/i.test(t)) return 'CM'
    if (/^단\/|^날씨(?:$|\s|\()|\[질문\s*\d|^주요뉴스\s*\d|^\(\+시보\)/i.test(t)) return '단신'
    if (/메인타이틀|DDR|타이틀/i.test(t)) return '타이틀'
    if (/스포츠\s*뉴스/i.test(t)) return CATEGORY_BLANK
  }

  if (isMiddleTitleToken(t) || /^(메인)?타이틀|DDR\s*타이틀|타이틀\s*\(?DDR|\[DDR\]/i.test(t) || /DDR타이틀|DDR\s*\+/i.test(t)) {
    return '타이틀'
  }
  if (/^전\s*CM|^전CM|\d부\s*전CM/i.test(t) || (t.startsWith('CM') && !t.startsWith('CM상'))) {
    return 'CM'
  }
  if (/스포츠\s*뉴스/i.test(t) || /스포츠\s*뉴스/i.test(flat)) return CATEGORY_BLANK
  if (/^오프닝/i.test(t) || /앵커\s*$/.test(t) || /^[가-힣]{2,5}\s*앵커$/.test(t)) return CATEGORY_BLANK
  if (/클로징|뉴스25\s*끝|뉴스끝/i.test(t)) return CATEGORY_BLANK
  if (!t && /앵커/.test(flat)) return CATEGORY_BLANK
  if (/^단\/|^단\/\s*날씨|^날씨(?:$|\s|\()|\[질문\s*\d/i.test(t) || t === '날씨') return '단신'
  if (/^주요뉴스\s*\d/i.test(t)) return '단신'
  if (/^\(\+시보\)/.test(t)) return '단신'
  if (chunk.some(isFormatComplete) || flat.includes('完')) return '완제'
  if (/(?:^|\s)L(?:\s|$)/.test(flat) && !/^오프닝/i.test(t)) return '완제'
  if (icons.includes('\uE00B') || icons.includes('\uE006') || icons.includes('\uE00A')) return '단신'
  if (icons.includes('\uE007') || icons.includes('\uE008') || icons.includes('\uE007')) return '완제'
  if (durationSeconds > 0 && durationSeconds <= 45 && !t) return '단신'
  if (t.startsWith('※') || /^\(SB\)/i.test(t)) return '단신'
  if (t) return '완제'
  return '단신'
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
  /** 클로징 다음 별도 행인 「뉴스25 끝」 */
  isNews25End?: boolean
  cueNo: number | null
  /** PDF 클로징(뉴스끝) 이후 NO·예비 구간 */
  isSpare?: boolean
}

function isClosingLeadToken(t: string): boolean {
  const s = t.trim()
  return /^클로징/i.test(s) || /^뉴스25\s*끝/i.test(s)
}

function isStructuralTitleToken(t: string): boolean {
  if (!t) return false
  if (/^오프닝/i.test(t)) return true
  if (t === '타이틀' || t === '날씨') return true
  if (/메인타이틀|DDR타이틀|타이틀\s*\(?DDR|\[DDR\]/i.test(t)) return true
  if (/^전\s*CM|^전CM|\d부\s*전CM/i.test(t)) return true
  if (/^\(\+시보\)/.test(t)) return true
  if (/^단\/|^주요뉴스\s*\d/.test(t)) return true
  if (/^[가-힣]{2,5}\s*앵커$/.test(t)) return true
  if (isClosingLeadToken(t)) return true
  return false
}

function advanceAtLeast(start: number, next: number, len: number): number {
  if (next > start) return next
  return Math.min(start + 1, len)
}
function isTitleLeadToken(t: string): boolean {
  if (!t || isTimeToken(t) || isRowNumber(t) || isIconToken(t)) return false
  if (isStructuralTitleToken(t)) return true
  return t.startsWith('[') || /^[가-힣A-Za-z0-9(※]/.test(t)
}

function isNumberedRowStart(tokens: string[], i: number): boolean {
  if (!isRowNumber(tokens[i] ?? '')) return false
  return i + 1 < tokens.length
}

function isAnchorRow(tokens: string[], i: number): boolean {
  const t = tokens[i] ?? ''
  return /^[가-힣]{2,5}\s*앵커$/.test(t) || (t === 'ANC' && tokens[i - 1] === '오프닝')
}

function isMiddleTitleToken(t: string): boolean {
  if (!t || isTimeToken(t) || isRowNumber(t)) return false
  if (/메인타이틀|DDR타이틀/i.test(t)) return false
  return /^지방선거|^중간|^브릿지|D-\d/i.test(t) || (t.length <= 24 && /타이틀|뉴스/i.test(t) && !/앵커/.test(t))
}

/** 뉴스외전 코너명 (정치 콕, 정치 맞수다, 경제 쏙, 외전 인터뷰 등) */
function cornerLabelFromBareName(bare: string): string | null {
  const name = bare.replace(/\s+/g, ' ').trim()
  if (!name || name.length > 32) return null
  if (/^특집뉴스외전#\d+$/i.test(name)) return name
  if (/^외전\s*人?터뷰$/i.test(name)) return '외전 인터뷰'
  if (/^[가-힣A-Za-z\u4e00-\u9fff]+\s*(?:콕|맞수다|쏙)$/i.test(name)) return name
  return null
}

/** 뉴스외전 코너 블럭 헤더 (*정치 콕, *정치 맞수다, [DDR] 경제 쏙 타이틀 등) */
function cornerLabelFromToken(t: string): string | null {
  const bare = t.replace(/^\*+/, '').replace(/\*[\d:]+…?$/i, '').trim()
  if (!bare) return null
  const ddr = bare.match(/\[DDR\]\s*(.+?)\s*타이틀/i)
  if (ddr) {
    const fromDdr = cornerLabelFromBareName(ddr[1]!.trim())
    if (fromDdr) return fromDdr
  }
  return cornerLabelFromBareName(bare)
}

function isCornerMarkerToken(t: string): boolean {
  return cornerLabelFromToken(t) != null
}

function chunkLeadLabel(chunk: string[]): string {
  for (const tok of chunk) {
    if (isIconToken(tok) || isTimeToken(tok) || tok === 'ANC' || tok === 'exr' || tok === 'DDR') continue
    if (isRowNumber(tok)) continue
    return tok
  }
  return ''
}

function isPostCmChunk(chunk: string[]): boolean {
  return /^후\s*CM|^후CM/i.test(chunkLeadLabel(chunk))
}

function isNews25EndChunk(chunk: string[]): boolean {
  return chunk.some((t) => /^뉴스25\s*끝/i.test(t) && !isIconToken(t))
}

function isRowBoundary(tokens: string[], i: number): boolean {
  if (isNumberedRowStart(tokens, i)) return true
  if (isSpecialStart(tokens, i) != null) return true
  if (isPreRowStart(tokens, i)) return true
  if (isClosingLeadToken(tokens[i] ?? '')) return true
  return false
}

function isClosingOnlyChunk(chunk: string[]): boolean {
  return chunk.some((t) => isClosingLeadToken(t) && !isIconToken(t))
}

function findCornerTitleInChunk(chunk: string[]): string | null {
  for (const tok of chunk) {
    if (isIconToken(tok) || isTimeToken(tok) || isFormatComplete(tok)) continue
    const label = cornerLabelFromToken(tok)
    if (label) return label
  }
  return null
}

function collectAnchorChunk(tokens: string[], start: number): { chunk: string[]; next: number } {
  const chunk: string[] = []
  let i = start
  if (isIconToken(tokens[i] ?? '')) {
    chunk.push(tokens[i]!)
    i++
  }
  while (i < tokens.length) {
    const t = tokens[i] ?? ''
    if (isNumberedRowStart(tokens, i)) break
    if (isRowNumber(t) && chunk.filter(isTimeToken).length >= 1) break
    if (isAnchorRow(tokens, i) || isTimeToken(t) || isIconToken(t) || t === '예비가상' || t === 'ANC' || t === '오프닝') {
      chunk.push(t)
      i++
      continue
    }
    if (chunk.some((c) => /앵커/.test(c)) && /^[가-힣]{2,5}$/.test(t)) break
    break
  }
  return { chunk, next: advanceAtLeast(start, i, tokens.length) }
}

function isPreRowStart(tokens: string[], i: number): boolean {
  const t = tokens[i] ?? ''
  if (!t) return false
  if (t === '타이틀' || t === '날씨' || t === '중간광고') return true
  if (/메인타이틀|DDR타이틀|타이틀\s*\(?DDR|\[DDR\]/i.test(t)) return true
  if (/^전\s*CM|^전CM|\d부\s*전CM|^CM\s*\(/i.test(t)) return true
  if (/^후\s*CM|^후CM/i.test(t)) return true
  if (isMiddleTitleToken(t)) return true
  if (/스포츠\s*뉴스/i.test(t)) return true
  if (/^오프닝/i.test(t)) return true
  if (/^\(\+시보\)/.test(t)) return true
  if (/^주요뉴스/.test(t)) return true
  if (/^날씨\s*\(/.test(t)) return true
  if (isIconToken(t) && tokens[i + 1] === '전') return true
  if (isIconToken(t) && tokens[i + 1] === '오프닝') return true
  if (isIconToken(t) && tokens[i + 1] === '이') return true
  if (isAnchorRow(tokens, i)) return true
  if (isCornerMarkerToken(t)) return true
  if (isIconToken(t) && isCornerMarkerToken(tokens[i + 1] ?? '')) return true
  return false
}

type SpecialKind =
  | 'cm_after'
  | 'closing'
  | 'server'
  | 'section'
  | 'headlines'
  | 'interstitial'

function isSpecialStart(tokens: string[], i: number): SpecialKind | null {
  const t = tokens[i] ?? ''
  const n = tokens[i + 1] ?? ''
  if (t === '후' && n === 'CM') return 'cm_after'
  if (/^후\s*CM|^후CM|\d부\s*후CM/i.test(t)) return 'cm_after'
  if (isClosingLeadToken(t)) return 'closing'
  if (t === '서버' && n === '영상') return 'server'
  if (/^잠시후/.test(t)) return 'interstitial'
  if (/^\d부\s+(타이틀|전CM)/i.test(t) || /^2부\s+타이틀/i.test(t)) return 'section'
  if (/^주요뉴스\s*\(/.test(t) || t === '주요뉴스(하단 S/S)') return 'headlines'
  if (t.startsWith('※')) return 'section'
  return null
}

function rowIsComplete(chunk: string[], numbered: boolean): boolean {
  const times = chunk.filter(isTimeToken)
  if (times.length < 2) return false
  if (numbered) {
    const hasReporter = chunk.some((tok, idx) => isReporterToken(tok) && isTimeToken(chunk[idx + 1] ?? ''))
    const hasTitle = chunk.some((tok, idx) => {
      if (idx === 0 && isRowNumber(tok)) return false
      return isTitleLeadToken(tok)
    })
    const onlyTimes =
      chunk.filter((tok) => isTimeToken(tok) || isRowNumber(tok) || isIconToken(tok) || isFormatComplete(tok))
        .length >= chunk.length - 1
    return hasReporter || hasTitle || onlyTimes
  }
  return true
}

/** 클로징·뉴스25 끝 — 시간 2개까지만 수집(다음 번호 아이템과 합쳐지지 않게) */
function collectClosingChunk(tokens: string[], start: number): { chunk: string[]; next: number } {
  const chunk: string[] = [tokens[start]!]
  let i = start + 1
  while (i < tokens.length) {
    if (isNumberedRowStart(tokens, i)) break
    if (i > start && isSpecialStart(tokens, i) === 'closing') break
    const t = tokens[i]!
    chunk.push(t)
    i++
    if (chunk.filter(isTimeToken).length >= 2) {
      while (i < tokens.length) {
        const n = tokens[i]!
        if (isNumberedRowStart(tokens, i) || isSpecialStart(tokens, i) || isTimeToken(n)) break
        chunk.push(n)
        i++
      }
      break
    }
  }
  return { chunk, next: advanceAtLeast(start, i, tokens.length) }
}

function collectUntilBoundary(
  tokens: string[],
  start: number,
  numbered: boolean,
): { chunk: string[]; next: number } {
  const chunk: string[] = numbered ? [tokens[start]!] : []
  let i = numbered ? start + 1 : start
  if (!numbered) chunk.push(tokens[start]!)

  while (i < tokens.length) {
    if (i > start && isClosingLeadToken(tokens[i] ?? '')) break
    if (numbered && rowIsComplete(chunk, true)) {
      if (isRowBoundary(tokens, i)) break
    }
    if (!numbered && rowIsComplete(chunk, false)) {
      if (isRowBoundary(tokens, i)) break
    }
    chunk.push(tokens[i]!)
    i++
    if (numbered && rowIsComplete(chunk, true)) {
      const next = tokens[i]
      if (
        next != null &&
        (isRowBoundary(tokens, i) || (isIconToken(next) && tokens[i + 1] === '서버'))
      ) {
        break
      }
    }
    if (!numbered && rowIsComplete(chunk, false)) {
      while (i < tokens.length) {
        if (isRowBoundary(tokens, i)) break
        chunk.push(tokens[i]!)
        i++
      }
      break
    }
  }
  return { chunk, next: advanceAtLeast(start, i, tokens.length) }
}

function segmentHeadlinesBlock(tokens: string[], start: number): { rows: string[][]; next: number } {
  const rows: string[][] = []
  let i = start
  while (i < tokens.length) {
    if (isPreRowStart(tokens, i) && !/^주요뉴스/.test(tokens[i] ?? '')) break
    if (isNumberedRowStart(tokens, i)) break
    if (isSpecialStart(tokens, i)) break
    const t = tokens[i] ?? ''
    if (/^주요뉴스\s*\d/.test(t)) {
      const { chunk, next } = collectUntilBoundary(tokens, i, false)
      rows.push(chunk)
      i = advanceAtLeast(i, next, tokens.length)
      continue
    }
    i++
    if (/^오프닝/.test(t)) break
  }
  return { rows, next: advanceAtLeast(start, i, tokens.length) }
}

function segmentTokenRows(tokens: string[]): string[][] {
  const rows: string[][] = []
  const used = new Array<boolean>(tokens.length).fill(false)
  let i = 0

  const markRange = (from: number, to: number) => {
    for (let k = from; k < to; k++) used[k] = true
  }

  const seenCueNos = new Set<number>()

  while (i < tokens.length) {
    const special = isSpecialStart(tokens, i)
    if (special === 'headlines') {
      const start = i
      const { rows: headlineRows, next } = segmentHeadlinesBlock(tokens, i)
      for (const hr of headlineRows) {
        rows.push(hr)
        const cue = hr.find((t) => isRowNumber(t))
        if (cue) seenCueNos.add(Number(cue))
      }
      markRange(start, next)
      i = advanceAtLeast(start, next, tokens.length)
      continue
    }
    if (special === 'section' || special === 'interstitial') {
      const start = i
      const { chunk, next } = collectUntilBoundary(tokens, i, false)
      rows.push(chunk)
      markRange(start, next)
      i = advanceAtLeast(start, next, tokens.length)
      continue
    }
    if (special === 'cm_after') {
      const start = i
      const { chunk, next } = collectUntilBoundary(tokens, i, false)
      rows.push(chunk)
      markRange(start, next)
      i = advanceAtLeast(start, next, tokens.length)
      continue
    }
    if (special === 'server') {
      rows.push(['서버', '영상', '자료'])
      markRange(i, i + 3)
      i += 3
      continue
    }
    if (special === 'closing') {
      const start = i
      const { chunk, next } = collectClosingChunk(tokens, i)
      rows.push(chunk)
      markRange(start, next)
      i = advanceAtLeast(start, next, tokens.length)
      continue
    }

    if (isAnchorRow(tokens, i) || (isIconToken(tokens[i] ?? '') && isAnchorRow(tokens, i + 1))) {
      const start = i
      const { chunk, next } = collectAnchorChunk(tokens, i)
      rows.push(chunk)
      markRange(start, next)
      i = advanceAtLeast(start, next, tokens.length)
      continue
    }

    if (isNumberedRowStart(tokens, i)) {
      const start = i
      const { chunk, next } = collectUntilBoundary(tokens, i, true)
      markRange(start, next)
      rows.push(chunk)
      seenCueNos.add(Number(chunk[0]))
      i = advanceAtLeast(start, next, tokens.length)
      continue
    }

    if (isPreRowStart(tokens, i)) {
      const start = i
      const { chunk, next } = collectUntilBoundary(tokens, i, false)
      markRange(start, next)
      rows.push(chunk)
      i = advanceAtLeast(start, next, tokens.length)
      continue
    }

    i++
  }

  // orphan: 번호·클로징 중복 없이 미사용 구간만 보충
  let orphanStart = -1
  for (let k = 0; k <= tokens.length; k++) {
    const isOrphan = k < tokens.length && !used[k]
    if (isOrphan && orphanStart < 0) orphanStart = k
    if ((!isOrphan || k === tokens.length) && orphanStart >= 0) {
      const slice = tokens.slice(orphanStart, k)
      const orphanCue = slice.find((t) => isRowNumber(t))
      const orphanNum = orphanCue ? Number(orphanCue) : null
      const maxCue = seenCueNos.size > 0 ? Math.max(...seenCueNos) : 0
      const hasClosing = slice.some((t) => isClosingLeadToken(t))
      if (
        slice.length > 0 &&
        slice.filter(isTimeToken).length >= 2 &&
        !(orphanNum != null && seenCueNos.has(orphanNum)) &&
        !(orphanNum != null && orphanNum > maxCue + 3) &&
        !hasClosing &&
        !slice.some((_, idx) => isPreRowStart(slice, idx))
      ) {
        rows.push(slice)
        if (orphanNum != null) seenCueNos.add(orphanNum)
      }
      orphanStart = -1
    }
  }

  return rows
}

function parseChunk(chunk: string[]): RawRow | null {
  if (chunk.length === 0) return null

  if (chunk[0] === '__SECTION__') {
    return {
      title: '',
      reporter: '',
      durationSeconds: 0,
      cumulativeSeconds: null,
      notes: '',
      category: '',
      sectionTitle: chunk[1] ?? '구간',
      isClosing: false,
      cueNo: null,
    }
  }

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
      cueNo: null,
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
      cueNo: null,
    }
  }

  const icons = chunk.filter(isIconToken).join('')
  const times = chunk.filter(isTimeToken)
  let { durationSeconds, cumulativeSeconds } = parseRowTimes(times)

  const joined = chunk.join(' ')
  const lineNo = isRowNumber(chunk[0] ?? '') ? Number(chunk[0]) : null

  if (/스포츠\s*뉴스/i.test(joined)) {
    const label = stripIcons(chunk.filter((t) => !isTimeToken(t) && !isIconToken(t)).join(' ')).slice(0, 48)
    return {
      title: '',
      reporter: '',
      durationSeconds: 0,
      cumulativeSeconds,
      notes: label || '스포츠 뉴스',
      category: CATEGORY_BLANK,
      sectionTitle: null,
      isClosing: false,
      cueNo: null,
    }
  }

  if (lineNo == null && isPostCmChunk(chunk)) {
    const title = stripIcons(chunkLeadLabel(chunk)) || '후 CM'
    const rowTimes = chunk.filter(isTimeToken)
    const { durationSeconds: postCmDur, cumulativeSeconds: postCmCum } = parseRowTimes(rowTimes.slice(0, 2))
    return {
      title,
      reporter: '',
      durationSeconds: postCmDur,
      cumulativeSeconds: postCmCum ?? cumulativeSeconds,
      notes: '',
      category: 'CM',
      sectionTitle: null,
      isClosing: false,
      cueNo: null,
    }
  }

  if (lineNo == null && (isClosingOnlyChunk(chunk) || isNews25EndChunk(chunk))) {
    const news25End = isNews25EndChunk(chunk)
    const rowTimes = chunk.filter(isTimeToken)
    const { durationSeconds: closingDur, cumulativeSeconds: closingCum } = parseRowTimes(
      rowTimes.slice(0, 2),
    )
    const notesParts: string[] = []
    let timeSeen = 0
    for (const tok of chunk) {
      if (isTimeToken(tok)) {
        timeSeen++
        continue
      }
      if (timeSeen >= 2) notesParts.push(tok)
    }
    const closingNote = news25End ? '뉴스25 끝' : '클로징'
    const cleanedNotes = stripIcons(notesParts.join(' '))
      .replace(/\bCM\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    let dur = closingDur
    if (dur > MAX_ITEM_DURATION_SEC) dur = 0

    return {
      title: '',
      reporter: '',
      durationSeconds: dur,
      cumulativeSeconds: closingCum ?? cumulativeSeconds,
      notes: cleanedNotes && !/^끝$/i.test(cleanedNotes) ? cleanedNotes : closingNote,
      category: CATEGORY_BLANK,
      sectionTitle: null,
      isClosing: true,
      isNews25End: news25End,
      cueNo: null,
    }
  }
  const ddrCornerFromText =
    cornerLabelFromToken(joined) ??
    chunk.map((tok) => cornerLabelFromToken(tok)).find((l): l is string => l != null) ??
    null

  const cornerTitle = findCornerTitleInChunk(chunk) ?? ddrCornerFromText
  if (cornerTitle && lineNo == null) {
    return {
      title: '',
      reporter: '',
      durationSeconds: 0,
      cumulativeSeconds: null,
      notes: '',
      category: '',
      sectionTitle: cornerTitle,
      isClosing: false,
      cueNo: null,
    }
  }

  const anchorOnly =
    cornerTitle == null &&
    lineNo == null &&
    /앵커/.test(joined) &&
    !chunk.some((tok, idx) => idx > 0 && isRowNumber(tok) && isFormatComplete(chunk[idx + 1] ?? ''))
  if (anchorOnly) {
    const m = joined.match(/([가-힣]{2,5})\s*앵커/)
    return {
      title: '',
      reporter: m?.[1] ?? '',
      durationSeconds: ANCHOR_BLANK_DURATION,
      cumulativeSeconds,
      notes: '앵커',
      category: CATEGORY_BLANK,
      sectionTitle: null,
      isClosing: false,
      cueNo: null,
    }
  }

  if (/^잠시후/.test(chunk[0] ?? '')) {
    return {
      title: stripIcons(chunk.filter((t) => !isTimeToken(t) && !isIconToken(t)).join(' ')),
      reporter: '',
      durationSeconds,
      cumulativeSeconds,
      notes: '',
      category: '',
      sectionTitle: '잠시후',
      isClosing: false,
      cueNo: null,
    }
  }

  if (/^\d부\s+(타이틀|전CM)/i.test(chunk[0] ?? '') || /^2부\s+타이틀/i.test(joined)) {
    return {
      title: '',
      reporter: '',
      durationSeconds: 0,
      cumulativeSeconds: null,
      notes: '',
      category: '',
      sectionTitle: stripIcons(chunk.filter((t) => !isTimeToken(t) && !isIconToken(t)).join(' ')).slice(0, 48),
      isClosing: false,
      cueNo: null,
    }
  }

  const firstTimeIdx = chunk.findIndex(isTimeToken)
  let reporterIdx = -1
  const bodyStart = lineNo != null ? 1 : 0
  for (let j = bodyStart; j < chunk.length; j++) {
    if (firstTimeIdx >= 0 && j >= firstTimeIdx) break
    if (!isReporterToken(chunk[j]!) || !isTimeToken(chunk[j + 1] ?? '')) continue
    const titleBefore = chunk
      .slice(bodyStart, j)
      .filter((tok) => !isIconToken(tok) && !isRowNumber(tok) && !isTimeToken(tok) && !isFormatComplete(tok))
    if (titleBefore.length > 0) {
      reporterIdx = j
      break
    }
  }

  const reporter = reporterIdx >= 0 ? chunk[reporterIdx]! : ''
  const titleParts: string[] = []
  const notesParts: string[] = []

  for (let j = 0; j < chunk.length; j++) {
    const tok = chunk[j]!
    if (lineNo != null && j === 0) continue
    if (isIconToken(tok) || isFormatComplete(tok)) continue
    if (j === reporterIdx) continue
    if (isTimeToken(tok)) continue
    if (tok === 'ANC' || tok === 'exr' || tok === 'CM상단' || tok === '상단' || tok === 'DDR') continue
    const timeCount = chunk.slice(0, j).filter(isTimeToken).length
    if (isStructuralTitleToken(tok)) {
      titleParts.push(tok)
      continue
    }
    if (firstTimeIdx >= 0 && timeCount >= 2 && j > firstTimeIdx) {
      notesParts.push(tok)
      continue
    }
    if (firstTimeIdx >= 0 && j > firstTimeIdx && timeCount >= 1 && reporterIdx < 0) {
      notesParts.push(tok)
      continue
    }
    titleParts.push(tok)
  }

  let title = stripIcons(titleParts.join(' '))
  let notes = stripIcons(notesParts.join(' '))
  let reporterOut = reporter

  if (!title && notes) {
    const nParts = notes.split(/\s+/).filter(Boolean)
    const struct = nParts.find((t) => isStructuralTitleToken(t))
    if (struct) {
      title = struct
      notes = nParts.filter((t) => t !== struct).join(' ')
    }
  }

  if (/^주요뉴스\s*\d/.test(title)) {
    // keep full headline title
  } else if (/^오프닝/i.test(title)) {
    if (!reporterOut && notes) {
      const parts = notes.split(/\s+/).filter(Boolean)
      if (parts[0] && /^[가-힣]{2,5}$/.test(parts[0])) {
        reporterOut = parts[0]
        notes = parts.slice(1).join(' ')
      }
    }
  } else if (/^[가-힣]{2,5}\s*앵커$/.test(title)) {
    reporterOut = title.replace(/\s*앵커$/, '')
    title = ''
  } else if (/앵커/.test(title)) {
    const m = title.match(/([가-힣]{2,5})\s*앵커/)
    if (m) {
      reporterOut = m[1]!
      title = ''
    }
  } else if (/^\(\+시보\)/.test(title)) {
    // 단신으로 분류
  } else if (title === '날씨' || /^단\//.test(title)) {
    // 단신으로 분류
  }

  if (!title && lineNo != null) title = `예비 ${lineNo}번`

  if (lineNo == null) {
    const cornerInTitle = title
      .split(/\s+/)
      .map((part) => cornerLabelFromToken(part))
      .find((label): label is string => label != null)
    if (
      cornerInTitle ||
      (cornerTitle && /콕|맞수다|쏙|특집뉴스외전|人터뷰|인터뷰/.test(title + (cornerTitle ?? '')))
    ) {
      return {
        title: '',
        reporter: reporterOut,
        durationSeconds: 0,
        cumulativeSeconds,
        notes: '',
        category: '',
        sectionTitle: cornerInTitle ?? cornerTitle!,
        isClosing: false,
        cueNo: null,
      }
    }
  }

  if (ddrCornerFromText && /\[DDR\]/i.test(joined)) {
    return {
      title: '',
      reporter: reporterOut,
      durationSeconds: 0,
      cumulativeSeconds,
      notes: '',
      category: '',
      sectionTitle: ddrCornerFromText,
      isClosing: false,
      cueNo: lineNo,
    }
  }

  let category = detectCategory(icons, title, durationSeconds, chunk)
  if (category === 'CM' && durationSeconds > 180) {
    const cmTimes = chunk.filter(isTimeToken)
    if (cmTimes.length >= 2) {
      const a = parseTimeToSeconds(cmTimes[cmTimes.length - 2]!) ?? 0
      const b = parseTimeToSeconds(cmTimes[cmTimes.length - 1]!) ?? 0
      if (b > a && b - a <= MAX_ITEM_DURATION_SEC) durationSeconds = b - a
    }
  }
  if (category === CATEGORY_BLANK && !title) {
    durationSeconds = defaultDurationForBlankSlot({
      notes: notes || (reporterOut ? '앵커' : ''),
      reporter: reporterOut,
      title: '',
    })
  }

  if (!title && durationSeconds === 0 && lineNo == null) {
    const fallback = stripIcons(chunk.filter((t) => !isTimeToken(t) && !isIconToken(t) && !isFormatComplete(t)).join(' '))
    if (!fallback) return null
    return {
      title: fallback,
      reporter: reporterOut,
      durationSeconds,
      cumulativeSeconds,
      notes,
      category: detectCategory(icons, fallback, durationSeconds, chunk),
      sectionTitle: null,
      isClosing: false,
      cueNo: lineNo,
    }
  }

  if (category === CATEGORY_BLANK) {
    const blankNotes = notes || (reporterOut ? '앵커' : '')
    return {
      title: '',
      reporter: reporterOut,
      durationSeconds: defaultDurationForBlankSlot({
        notes: blankNotes,
        reporter: reporterOut,
        title: '',
      }),
      cumulativeSeconds,
      notes: blankNotes,
      category: CATEGORY_BLANK,
      sectionTitle: null,
      isClosing: false,
      cueNo: lineNo,
    }
  }

  return {
    title,
    reporter: reporterOut,
    durationSeconds,
    cumulativeSeconds,
    notes,
    category,
    sectionTitle: null,
    isClosing: false,
    cueNo: lineNo,
  }
}

/** PDF 토큰 순서상 후CM 시간이 클로징 행에 붙는 경우 보정 (뉴스25 등) */
function rebalancePostCmAndClosingRows(rows: RawRow[]): void {
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = rows[i]!
    const next = rows[i + 1]!
    if ((/^후\s*CM|^후CM/i.test(cur.title) || cur.category === 'CM') && cur.durationSeconds === 0) {
      if (next.isClosing && !next.isNews25End && next.durationSeconds > 0) {
        cur.durationSeconds = next.durationSeconds
        cur.category = 'CM'
        if (!cur.title) cur.title = '후 CM'
      }
    }
    if (cur.isClosing && !cur.isNews25End && next.isNews25End && next.durationSeconds > 0) {
      cur.durationSeconds = next.durationSeconds
    }
  }
}

/** CM·뉴스25 끝만 남을 때 클로징 5초 행 보강 */
function ensureNews25ClosingPair(rows: RawRow[]): void {
  const closingIdx = rows.findIndex((r) => r.isClosing && r.isNews25End && r.durationSeconds > 0)
  if (closingIdx <= 0) return
  const prev = rows[closingIdx - 1]
  const cur = rows[closingIdx]!
  if (!prev || !/^후\s*CM|^후CM/i.test(prev.title)) return
  if (rows.some((r) => r.isClosing && !r.isNews25End && r.durationSeconds > 0)) return
  rows.splice(closingIdx, 0, {
    ...cur,
    notes: '클로징',
    isNews25End: false,
    durationSeconds: cur.durationSeconds,
  })
}

function pruneDuplicateNews25EndRows(rows: RawRow[]): RawRow[] {
  const out: RawRow[] = []
  for (const row of rows) {
    if (row.isClosing && row.isNews25End && row.durationSeconds === 0) {
      const prev = out[out.length - 1]
      if (prev?.isClosing && prev.isNews25End && prev.durationSeconds > 0) continue
    }
    out.push(row)
  }
  return out
}

/** cueNo 중복 제거; 마지막 클로징(뉴스25 끝) 이후 행은 예비(isSpare) */
function dedupeNumberedRows(rows: RawRow[]): RawRow[] {
  const seenMain = new Set<number>()
  const seenSpare = new Set<number>()
  const out: RawRow[] = []
  let pastClosing = false
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (row.isClosing) {
      out.push(row)
      const hasLaterClosing = rows.slice(i + 1).some((r) => r.isClosing)
      if (row.isNews25End || !hasLaterClosing) pastClosing = true
      continue
    }
    if (pastClosing) {
      if (row.cueNo != null && seenSpare.has(row.cueNo)) continue
      if (row.cueNo != null) seenSpare.add(row.cueNo)
      out.push({ ...row, isSpare: true })
      continue
    }
    if (row.cueNo != null && seenMain.has(row.cueNo)) continue
    if (row.cueNo != null) seenMain.add(row.cueNo)
    out.push(row)
  }
  return out
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
  newsStartTime: string
}

function parseMetaFromTokens(allPageTokens: string[][]): PdfParseMeta {
  const flat = allPageTokens.flat().join('\t')
  let programTitle = 'PDF 큐시트'
  let broadcastDate = new Date().toISOString().slice(0, 10)

  const mbcMatch = flat.match(/MBC\s+([^\t(]+?)(?:\((\d{4}-\d{2}-\d{2})\))?/)
  if (mbcMatch) {
    programTitle = mbcMatch[1]!.trim()
    if (mbcMatch[2]) broadcastDate = mbcMatch[2]
  } else {
    const uhd = flat.match(/(UHD\s*뉴스데스크[^\t(]*(?:\(\d{4}-\d{2}-\d{2}\))?)/i)
    if (uhd) programTitle = uhd[1]!.trim()
    const dateMatch = flat.match(/(\d{4}-\d{2}-\d{2})/)
    if (dateMatch) broadcastDate = dateMatch[1]!
  }

  const minMatch =
    programTitle.match(/(\d+)\s*분간/) ||
    flat.match(/(\d+)\s*분간/) ||
    programTitle.match(/(\d+)\s*분/) ||
    flat.match(/특집[_\s]*(\d+)분/i)
  const scheduledSeconds = minMatch ? Number(minMatch[1]) * 60 : 21 * 60

  const ancMatch = flat.match(/ANC:\s*([가-힣\s,]+?)(?:\t|PD:|$)/)
  const pdMatch = flat.match(/PD:\s*([가-힣]+)/)

  let newsStartTime = '12:00:00'
  if (/930/.test(programTitle + flat)) newsStartTime = '09:30:00'
  if (/뉴스25|news25/i.test(programTitle + flat)) newsStartTime = '09:25:00'
  if (/데스크/i.test(programTitle + flat)) newsStartTime = '21:00:00'
  if (/투데이|today/i.test(programTitle + flat)) newsStartTime = '20:00:00'

  return {
    programTitle,
    broadcastDate,
    scheduledSeconds,
    anchorName: ancMatch?.[1]?.trim() ?? '',
    pdName: pdMatch?.[1] ?? '',
    episodeLabel: programTitle,
    newsStartTime,
  }
}

function guessProgramIdFromText(text: string): string {
  const head = text.slice(0, 1500)
  if (/외전|특집뉴스외전|outside/i.test(head)) return 'news_extra'
  if (/투데이|news\s*today|today/i.test(head)) return 'news_today'
  if (/뉴스25|news25|\b25뉴스/i.test(head)) return 'news_25'
  if (/데스크|desk/i.test(head)) return 'news_desk'
  if (/UHD\s*930|930\s*뉴스|MBC\s*930/i.test(head)) return 'news_930'
  if (/\b930\b/.test(head) && !/\[930\//.test(head)) return 'news_930'
  if (/경제|economy/i.test(head)) return 'news_economy'
  if (/12\s*뉴스|12뉴스/i.test(head)) return 'news_12'
  return 'news_12'
}

const PROGRAM_NAMES: Record<string, string> = {
  news_12: '12시뉴스',
  news_930: '930뉴스',
  news_25: '뉴스25',
  news_desk: '뉴스데스크',
  news_extra: '뉴스외전',
  news_economy: '뉴스와 경제',
  news_today: '뉴스투데이',
}

function includeInRunForParsedRow(row: RawRow, category: string, durationSeconds: number): boolean {
  if (row.isSpare) {
    if (category === CATEGORY_BLANK) return true
    return durationSeconds > 0 || row.title.trim().length > 0
  }
  if (category === CATEGORY_BLANK) return true
  return durationSeconds > 0
}

function rawRowToItems(row: RawRow): RundownItem[] {
  const flags = row.isSpare ? ['pdf', 'spare'] : ['pdf']

  if (row.sectionTitle) {
    return [
      {
        id: uid('s_'),
        kind: 'sectionHeader',
        title: row.sectionTitle,
        durationSeconds: row.durationSeconds,
        includeInRun: row.durationSeconds > 0,
      },
    ]
  }

  if (row.isClosing) {
    return [
      {
        id: uid('i_'),
        kind: 'newsItem',
        category: CATEGORY_BLANK,
        reporter: '',
        title: '',
        durationSeconds: row.durationSeconds,
        notes: row.notes,
        isDefaultItem: false,
        isEmphasis: false,
        isTimeAdjust: false,
        includeInRun: true,
        flags: ['pdf', 'closing'],
        cueNo: row.cueNo ?? undefined,
      },
    ]
  }

  const category = normalizeNewsCategory(row.category, row.title)
  const durationSeconds =
    category === CATEGORY_BLANK && !row.title
      ? defaultDurationForBlankSlot({ notes: row.notes, reporter: row.reporter, title: row.title })
      : row.durationSeconds

  return [
    {
      id: uid('i_'),
      kind: 'newsItem',
      category,
      reporter: row.reporter,
      title: category === CATEGORY_BLANK ? '' : row.title,
      durationSeconds: category === CATEGORY_BLANK && row.durationSeconds > MAX_ITEM_DURATION_SEC ? 0 : durationSeconds,
      notes: row.notes,
      isDefaultItem: false,
      isEmphasis: false,
      isTimeAdjust: false,
      includeInRun: includeInRunForParsedRow(row, category, durationSeconds),
      flags,
      cueNo: row.cueNo ?? undefined,
    },
  ]
}

function shouldSkipDuplicateSection(target: RundownItem[], row: RawRow): boolean {
  if (!row.sectionTitle) return false
  const last = target[target.length - 1]
  return last?.kind === 'sectionHeader' && last.title === row.sectionTitle
}

function rawRowsToItems(rows: RawRow[]): RundownItem[] {
  const main: RundownItem[] = []
  const spare: RundownItem[] = []
  let closingItemIndex = -1

  for (const row of rows) {
    const target = row.isSpare ? spare : main
    if (shouldSkipDuplicateSection(target, row)) continue
    const built = rawRowToItems(row)
    if (row.isSpare) {
      spare.push(...built)
      continue
    }
    if (row.isClosing) closingItemIndex = main.length
    main.push(...built)
  }

  const marker: RundownItem = { id: uid('m_'), kind: 'marker', title: '뉴스끝', includeInRun: false }
  const endIdx = closingItemIndex >= 0 ? closingItemIndex : main.length - 1
  const merged = [...main.slice(0, endIdx + 1), marker, ...spare]

  return insertVisualBlankSeparators(merged)
}

export async function parsePdfToRundown(
  file: File,
  opts: { programId?: string; programName?: string } = {},
): Promise<Rundown> {
  const pages = await extractPdfPageTokens(file)
  const meta = parseMetaFromTokens(pages)
  const flat = pages.flat().join('\t')
  const tokens = mergeCueTokens(pages)
  const chunks = segmentTokenRows(tokens)
  const parsedRows = chunks.map(parseChunk).filter((r): r is RawRow => r != null)
  rebalancePostCmAndClosingRows(parsedRows)
  ensureNews25ClosingPair(parsedRows)
  const rawRows = dedupeNumberedRows(pruneDuplicateNews25EndRows(parsedRows))

  if (rawRows.length === 0) {
    throw new Error('PDF에서 큐시트 행을 찾지 못했습니다. MBC 뉴스 큐시트 PDF인지 확인해 주세요.')
  }

  const inferredId = guessProgramIdFromText(`${meta.programTitle}\t${flat}\t${file.name}`)
  const programId = opts.programId ?? inferredId
  const programName = opts.programName ?? PROGRAM_NAMES[programId] ?? meta.programTitle

  const items = rawRowsToItems(rawRows)
  const includedTotal = sumIncludedSeconds(items)
  const newsEndTime = addSecondsToClock(meta.newsStartTime, includedTotal) || meta.newsStartTime

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
      newsStartTime: meta.newsStartTime,
      scheduledSeconds: meta.scheduledSeconds,
      newsEndTime,
      budgetMode: 'scheduled',
      autoStartAtNewsTime: true,
      toleranceSeconds: 15,
    },
    items,
  }
}
