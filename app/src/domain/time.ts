import type { Rundown, RundownItem } from './types'

export function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export function formatDelta(deltaSeconds: number): string {
  const sign = deltaSeconds >= 0 ? '+' : '-'
  return `${sign}${formatSeconds(Math.abs(deltaSeconds))}`
}

export function parseTimeToSeconds(input: string): number | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10))

  const parts = raw.split(':').map((p) => p.trim())
  if (parts.some((p) => p === '' || !/^\d+$/.test(p))) return null
  if (parts.length === 2) {
    const [mm, ss] = parts.map((x) => parseInt(x, 10))
    if (ss >= 60) return null
    return Math.max(0, mm * 60 + ss)
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = parts.map((x) => parseInt(x, 10))
    if (mm >= 60 || ss >= 60) return null
    return Math.max(0, hh * 3600 + mm * 60 + ss)
  }
  return null
}

function addSecondsToClock(clockHHMMSS: string, secondsToAdd: number): string {
  const parsed = parseClock(clockHHMMSS)
  if (!parsed) return ''
  const total = parsed.hh * 3600 + parsed.mm * 60 + parsed.ss + secondsToAdd
  const s = ((total % 86400) + 86400) % 86400
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function parseClock(clockHHMMSS: string): { hh: number; mm: number; ss: number } | null {
  const parts = clockHHMMSS.trim().split(':')
  if (parts.length !== 3) return null
  if (parts.some((p) => p === '' || !/^\d+$/.test(p))) return null
  const [hh, mm, ss] = parts.map((x) => parseInt(x, 10))
  if (hh > 23 || mm > 59 || ss > 59) return null
  return { hh, mm, ss }
}

export type ComputedRow = {
  item: RundownItem
  isAfterEnd: boolean
  isIncluded: boolean
  startTime: string | null
}

export function computeRundown(rundown: Rundown): {
  rows: ComputedRow[]
  includedTotalSeconds: number
  deltaSeconds: number
} {
  const rows: ComputedRow[] = []

  let afterEnd = false
  let runningIncludedSeconds = 0
  let includedTotalSeconds = 0

  // First pass compute included total seconds
  for (const it of rundown.items) {
    if (it.kind === 'marker' && it.title === '뉴스끝') afterEnd = true
    const included = !afterEnd && it.kind === 'newsItem' && it.includeInRun
    if (included) includedTotalSeconds += it.durationSeconds
  }

  // Second pass compute per-row start times for included rows
  afterEnd = false
  for (const it of rundown.items) {
    const isMarkerEnd = it.kind === 'marker' && it.title === '뉴스끝'
    if (isMarkerEnd) afterEnd = true

    const isIncluded = !afterEnd && it.kind === 'newsItem' && it.includeInRun
    const startTime = isIncluded ? addSecondsToClock(rundown.timing.newsStartTime, runningIncludedSeconds) : null
    rows.push({ item: it, isAfterEnd: afterEnd && !isMarkerEnd, isIncluded, startTime })
    if (isIncluded && it.kind === 'newsItem') runningIncludedSeconds += it.durationSeconds
  }

  return {
    rows,
    includedTotalSeconds,
    deltaSeconds: rundown.timing.scheduledSeconds - includedTotalSeconds,
  }
}

