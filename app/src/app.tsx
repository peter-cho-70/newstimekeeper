import { useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import type { ArticleScript, BudgetMode, Rundown, RundownItem, Template } from './domain/types'
import { ArticleEditorModal } from './components/ArticleEditorModal'
import {
  addSecondsToClock,
  computeBudgetSeconds,
  computeRundown,
  formatDelta,
  formatSeconds,
  parseTimeToSeconds,
} from './domain/time'
import { NEWS_ECONOMY_TEMPLATE, NEWS_EXTRA_TEMPLATE } from './templates'
import { readJsonFile } from './domain/file'
import { parsePdfToRundown } from './domain/pdfRundownParser'
import { applyActualDurationsFromPlay, hasPlaybackDurationData } from './domain/playbackApply'
import {
  CATEGORY_BLANK,
  CUE_CATEGORIES,
  categoryLabelForUi,
  defaultDurationForBlankSlot,
  defaultDurationForCategory,
  isArticleCategory,
  isBlankSlotCategory,
  normalizeNewsCategory,
} from './domain/cueCategories'
import { uid } from './domain/uid'

type ProgramId = string

type ProgramDef = { id: ProgramId; name: string; builtIn: boolean; template?: Template }

const BUILTIN_PROGRAMS: ProgramDef[] = [
  { id: 'news_extra', name: '뉴스외전', builtIn: true, template: NEWS_EXTRA_TEMPLATE },
  { id: 'news_economy', name: '뉴스와 경제', builtIn: true, template: NEWS_ECONOMY_TEMPLATE },
  { id: 'news_12', name: '12시뉴스', builtIn: true },
  { id: 'news_930', name: '930뉴스', builtIn: true },
  { id: 'news_desk', name: '뉴스데스크', builtIn: true },
  { id: 'news_25', name: '뉴스25', builtIn: true },
  { id: 'news_today', name: '뉴스투데이', builtIn: true },
]

const PROGRAMS_KEY = 'newstimekeeper:programs:v1'

function isArticleNewsItem(it: RundownItem): it is RundownItem & { kind: 'newsItem' } {
  return it.kind === 'newsItem' && isArticleCategory(it.category)
}

function guessProgramIdFromPdfName(filename: string): ProgramId {
  if (/outside|외전/i.test(filename)) return 'news_extra'
  if (/today|투데이/i.test(filename)) return 'news_today'
  if (/930/i.test(filename)) return 'news_930'
  if (/news25|뉴스25|^25/i.test(filename)) return 'news_25'
  if (/desk|데스크/i.test(filename)) return 'news_desk'
  if (/경제|economy/i.test(filename)) return 'news_economy'
  if (/12|12시/i.test(filename)) return 'news_12'
  return 'news_12'
}

const STORAGE_KEY_PREFIX = 'newstimekeeper:rundown:v1:'
const TEMPLATE_KEY_PREFIX = 'newstimekeeper:template:v1:'

type PlayState = 'idle' | 'running' | 'paused'
type AdvanceMode = 'auto' | 'manual'
type ResumeAfterBack = { includedIndex: number; itemId: string }
type PlaySession = {
  state: PlayState
  currentIncludedIndex: number
  itemStartedAtMs: number | null
  pausedAtMs: number | null
  pausedAccumulatedMs: number
  // Per-item elapsed cache for "go back" behavior.
  elapsedByItemIdMs: Record<string, number>
  /** Duration (seconds) when the item started playing — for 초기 vs 실제 diff display. */
  plannedDurationSecondsByItemId: Record<string, number>
  newsStartedAtMs: number | null
  /** Set when user steps back one item; next advance restores this item without committing the review item. */
  resumeAfterBack: ResumeAfterBack | null
}

function idlePlaySession(): PlaySession {
  return {
    state: 'idle',
    currentIncludedIndex: 0,
    itemStartedAtMs: null,
    pausedAtMs: null,
    pausedAccumulatedMs: 0,
    elapsedByItemIdMs: {},
    plannedDurationSecondsByItemId: {},
    newsStartedAtMs: null,
    resumeAfterBack: null,
  }
}

function snapshotPlannedDurationIfNeeded(
  planned: Record<string, number>,
  item: RundownItem | undefined,
): Record<string, number> {
  if (!item || (item.kind !== 'newsItem' && item.kind !== 'sectionHeader')) return planned
  if (planned[item.id] != null) return planned
  return { ...planned, [item.id]: item.durationSeconds }
}

function includedIndexOfItem(itemId: string, includedRows: Array<{ item: { id: string } }>): number {
  return includedRows.findIndex((r) => r.item.id === itemId)
}

/** Items already passed in the included run order cannot be edited during play. */
function isItemLockedDuringPlay(
  itemId: string,
  play: PlaySession,
  includedRows: Array<{ item: { id: string } }>,
): boolean {
  if (play.state === 'idle') return false
  const idx = includedIndexOfItem(itemId, includedRows)
  if (idx < 0) return false
  const curIdx = Math.min(play.currentIncludedIndex, Math.max(0, includedRows.length - 1))
  return idx < curIdx
}

function storageKeyForRundown(programId: ProgramId) {
  return `${STORAGE_KEY_PREFIX}${programId}`
}
function storageKeyForTemplate(programId: ProgramId) {
  return `${TEMPLATE_KEY_PREFIX}${programId}`
}


function nowClockHHMMSS() {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** Display-only: progress clocks run 1s ahead of measured elapsed. */
const LIVE_PROGRESS_DISPLAY_OFFSET_SECONDS = 1

function currentElapsedMsForPlaySession(now: number, p: PlaySession): number {
  if (p.state === 'idle') return 0
  const baseStartedAt = p.itemStartedAtMs ?? now
  const effectiveNow = p.state === 'paused' ? p.pausedAtMs ?? now : now
  return Math.max(0, effectiveNow - baseStartedAt - p.pausedAccumulatedMs)
}

function wallClockNewsElapsedSeconds(play: PlaySession, nowMs: number): number {
  if (play.state === 'idle' || play.newsStartedAtMs == null) return 0
  const effectiveNow = play.state === 'paused' ? play.pausedAtMs ?? nowMs : nowMs
  return Math.max(0, Math.floor((effectiveNow - play.newsStartedAtMs - play.pausedAccumulatedMs) / 1000))
}

function displayedNewsProgressSeconds(play: PlaySession, nowMs: number): number {
  if (play.state === 'idle') return 0
  return wallClockNewsElapsedSeconds(play, nowMs) + LIVE_PROGRESS_DISPLAY_OFFSET_SECONDS
}

/** Measured item elapsed (no display offset) — for 편성 vs 진행 diff and projected end. */
function rawItemElapsedSeconds(play: PlaySession, effectiveNowMs: number): number {
  if (play.state === 'idle') return 0
  return Math.floor(currentElapsedMsForPlaySession(effectiveNowMs, play) / 1000)
}

/** Positive = under planned duration; negative = over. */
function plannedVsActualRemainingSeconds(plannedSeconds: number, actualElapsedSeconds: number): number {
  return plannedSeconds - actualElapsedSeconds
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  if (!t) return false
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true
  return t.isContentEditable
}

/** 진행 중 입력 없을 때: 선택을 현재 아이템으로 맞춤 · 편집 후 스페이스 = 다음 아이템 */
const SPACE_ADVANCE_IDLE_MS = 5_000

function toAsciiSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function autoProgramId(name: string, existing: Set<string>): string {
  const slug = toAsciiSlug(name)
  if (slug && !existing.has(slug)) return slug
  const base = slug ? `news_${slug}` : 'news'
  if (!existing.has(base)) return base
  // Guaranteed-unique fallback (stable enough for local use)
  let id = `${base}_${uid('p_').replace(/[^a-z0-9_-]/gi, '')}`
  while (existing.has(id)) id = `${base}_${uid('p_').replace(/[^a-z0-9_-]/gi, '')}`
  return id
}

function createEmptyRundown(p: Pick<ProgramDef, 'id' | 'name'>): Rundown {
  const marker: RundownItem = { id: uid('m_'), kind: 'marker', title: '뉴스끝', includeInRun: false }
  return {
    schemaVersion: '1.0',
    type: 'rundown',
    programId: p.id,
    programName: p.name,
    broadcastDate: new Date().toISOString().slice(0, 10),
    episodeLabel: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timing: {
      newsStartTime: '20:00:00',
      scheduledSeconds: 3060,
      newsEndTime: '20:51:00',
      budgetMode: 'scheduled',
      autoStartAtNewsTime: true,
      toleranceSeconds: 15,
    },
    items: [marker],
  }
}

function defaultNewsEndTime(newsStartTime: string, scheduledSeconds: number): string {
  return addSecondsToClock(newsStartTime, scheduledSeconds) || newsStartTime
}

function normalizeRundown(r: Rundown): Rundown {
  const budgetMode: BudgetMode = r.timing?.budgetMode === 'endClock' ? 'endClock' : 'scheduled'
  const newsStartTime = r.timing?.newsStartTime ?? '20:00:00'
  const scheduledSeconds = typeof r.timing?.scheduledSeconds === 'number' ? r.timing.scheduledSeconds : 3060
  const newsEndTime =
    typeof r.timing?.newsEndTime === 'string' && r.timing.newsEndTime.trim()
      ? r.timing.newsEndTime
      : defaultNewsEndTime(newsStartTime, scheduledSeconds)

  const items = r.items.map((it) => {
    if (it.kind === 'sectionHeader') {
      const dur = typeof (it as any).durationSeconds === 'number' ? (it as any).durationSeconds : 0
      return { ...it, durationSeconds: dur }
    }
    if (it.kind === 'newsItem') {
      const category = normalizeNewsCategory(it.category, it.title)
      const anchorDur = defaultDurationForBlankSlot({
        notes: it.notes,
        reporter: it.reporter,
        title: it.title,
      })
      const durationSeconds =
        isBlankSlotCategory(category) && !it.title.trim() && anchorDur > 0 && it.durationSeconds === 0
          ? anchorDur
          : it.durationSeconds
      return {
        ...it,
        category,
        durationSeconds,
        isTimeAdjust: false,
      }
    }
    return it
  })
  return {
    ...r,
    items,
    timing: {
      ...r.timing,
      newsStartTime,
      scheduledSeconds,
      newsEndTime,
      budgetMode,
      autoStartAtNewsTime: r.timing?.autoStartAtNewsTime !== false,
      toleranceSeconds: typeof r.timing?.toleranceSeconds === 'number' ? r.timing.toleranceSeconds : 15,
    },
  }
}

function normalizeTemplate(t: Template): Template {
  return {
    ...t,
    items: t.items.map((it) => {
      if (it.kind === 'sectionHeader') {
        const dur = typeof (it as any).durationSeconds === 'number' ? (it as any).durationSeconds : 0
        return { ...it, durationSeconds: dur }
      }
      return it
    }),
  }
}

function rundownToTemplate(rundown: Rundown): Template {
  return {
    schemaVersion: '1.0',
    type: 'template',
    programId: rundown.programId,
    programName: rundown.programName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaults: {
      scheduledSeconds: rundown.timing.scheduledSeconds,
      newsStartTime: rundown.timing.newsStartTime,
    },
    items: rundown.items.map((it) => {
      if (it.kind === 'newsItem') return { ...it, id: uid('t_') }
      return { ...it, id: uid('t_') }
    }),
  }
}

function cloneTemplateToRundown(template: Template): Rundown {
  const items: RundownItem[] = template.items.map((it) => {
    if (it.kind === 'newsItem') {
      return { ...it, id: uid('i_') }
    }
    return { ...it, id: uid('r_') }
  })
  return {
    schemaVersion: '1.0',
    type: 'rundown',
    programId: template.programId,
    programName: template.programName,
    broadcastDate: new Date().toISOString().slice(0, 10),
    episodeLabel: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timing: {
      newsStartTime: template.defaults.newsStartTime,
      scheduledSeconds: template.defaults.scheduledSeconds,
      newsEndTime: defaultNewsEndTime(template.defaults.newsStartTime, template.defaults.scheduledSeconds),
      budgetMode: 'scheduled',
      autoStartAtNewsTime: true,
      toleranceSeconds: 15,
    },
    items,
  }
}

function App() {
  const [programId, setProgramId] = useState<ProgramId | null>(null)
  const [rundown, setRundown] = useState<Rundown | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pdfFileInputRef = useRef<HTMLInputElement | null>(null)
  const templatesFileInputRef = useRef<HTMLInputElement | null>(null)
  const [pdfImportBusy, setPdfImportBusy] = useState(false)
  const [focusItemId, setFocusItemId] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const pinnedFooterRef = useRef<HTMLDivElement | null>(null)
  const [pinnedFooterHeight, setPinnedFooterHeight] = useState<number>(0)
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const [play, setPlay] = useState<PlaySession>(() => idlePlaySession())
  const [advanceMode, setAdvanceMode] = useState<AdvanceMode>('manual')
  const autoStartLatchRef = useRef<string | null>(null)
  const playStateRef = useRef<PlayState>('idle')
  const lastUserActivityAtMsRef = useRef(Date.now())
  const itemEditedDuringPlayRef = useRef(false)

  const [newsStartDraft, setNewsStartDraft] = useState<string>('20:00:00')
  const [scheduledDraft, setScheduledDraft] = useState<string>('51:00')
  const [newsEndDraft, setNewsEndDraft] = useState<string>('20:51:00')
  const tableScrollRef = useRef<HTMLDivElement | null>(null)

  const [programs, setPrograms] = useState<ProgramDef[]>(() => {
    try {
      const raw = localStorage.getItem(PROGRAMS_KEY)
      const parsed = raw ? (JSON.parse(raw) as Array<{ id: string; name: string }>) : []
      const custom: ProgramDef[] = parsed
        .filter((p) => typeof p?.id === 'string' && typeof p?.name === 'string')
        .map((p) => ({ id: p.id, name: p.name, builtIn: false }))
      return [...BUILTIN_PROGRAMS, ...custom]
    } catch {
      return [...BUILTIN_PROGRAMS]
    }
  })
  const [newProgramNameDraft, setNewProgramNameDraft] = useState<string>('')
  const [articleEditorItemId, setArticleEditorItemId] = useState<string | null>(null)

  function persistCustomPrograms(nextPrograms: ProgramDef[]) {
    const custom = nextPrograms.filter((p) => !p.builtIn).map((p) => ({ id: p.id, name: p.name }))
    localStorage.setItem(PROGRAMS_KEY, JSON.stringify(custom))
  }

  const selectedIndex = useMemo(() => {
    if (!rundown || !selectedItemId) return null
    const idx = rundown.items.findIndex((x) => x.id === selectedItemId)
    return idx >= 0 ? idx : null
  }, [rundown, selectedItemId])

  useEffect(() => {
    if (!focusItemId) return
    const id = focusItemId
    const raf = window.requestAnimationFrame(() => {
      const el = document.getElementById(`title-${id}`) as HTMLInputElement | null
      if (el) {
        el.focus()
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
      setFocusItemId(null)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [focusItemId])

  useEffect(() => {
    const el = pinnedFooterRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setPinnedFooterHeight(Math.ceil(el.getBoundingClientRect().height))
    })
    ro.observe(el)
    setPinnedFooterHeight(Math.ceil(el.getBoundingClientRect().height))
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const tickMs = play.state === 'idle' && rundown?.timing.autoStartAtNewsTime !== false ? 500 : 200
    const t = window.setInterval(() => {
      setNowMs(Date.now())
    }, tickMs)
    return () => window.clearInterval(t)
  }, [play.state, rundown?.timing.autoStartAtNewsTime])

  // Keep selected row visible in the scroll container
  useEffect(() => {
    if (!selectedItemId) return
    const container = tableScrollRef.current
    if (!container) return
    const el = document.getElementById(`row-${selectedItemId}`) as HTMLElement | null
    if (!el) return

    const raf = window.requestAnimationFrame(() => {
      const c = container.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const padding = 12
      const above = r.top < c.top + padding
      const below = r.bottom > c.bottom - padding
      if (!above && !below) return
      // Use scrollIntoView with container-friendly options
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => window.cancelAnimationFrame(raf)
  }, [selectedItemId])

  useEffect(() => {
    if (!rundown) return
    setNewsStartDraft(rundown.timing.newsStartTime)
    setNewsEndDraft(rundown.timing.newsEndTime)
    if (rundown.timing.budgetMode === 'endClock') {
      setScheduledDraft(formatSeconds(computeBudgetSeconds(rundown.timing)))
    } else {
      setScheduledDraft(formatSeconds(rundown.timing.scheduledSeconds))
    }
  }, [
    rundown?.timing.newsStartTime,
    rundown?.timing.scheduledSeconds,
    rundown?.timing.newsEndTime,
    rundown?.timing.budgetMode,
  ])

  const timingDraftDirty = useMemo(() => {
    if (!rundown) return false
    if (newsStartDraft.trim() !== rundown.timing.newsStartTime) return true
    if (rundown.timing.budgetMode === 'endClock') {
      return newsEndDraft.trim() !== rundown.timing.newsEndTime
    }
    const secs = parseTimeToSeconds(scheduledDraft)
    return secs != null && secs !== rundown.timing.scheduledSeconds
  }, [rundown, newsStartDraft, scheduledDraft, newsEndDraft])

  function applyTimingEdits() {
    if (!rundown) return
    const start = newsStartDraft.trim()
    if (!start) return

    if (rundown.timing.budgetMode === 'endClock') {
      const end = newsEndDraft.trim()
      if (!end) return
      setRundownSafe((prev) => ({
        ...prev,
        timing: { ...prev.timing, newsStartTime: start, newsEndTime: end },
      }))
      return
    }

    const secs = parseTimeToSeconds(scheduledDraft)
    if (secs == null) {
      setScheduledDraft(formatSeconds(rundown.timing.scheduledSeconds))
      return
    }
    setRundownSafe((prev) => ({
      ...prev,
      timing: {
        ...prev.timing,
        newsStartTime: start,
        scheduledSeconds: secs,
        newsEndTime: defaultNewsEndTime(start, secs),
      },
    }))
  }

  function moveSelected(delta: -1 | 1) {
    if (!rundown || selectedIndex == null || !selectedItemId) return
    if (isItemLockedDuringPlay(selectedItemId, play, includedRows)) return
    const idx = selectedIndex
    const target = idx + delta
    if (target < 0 || target >= rundown.items.length) return
    const cur = rundown.items[idx]
    if (!cur) return
    if (cur.kind === 'marker' && cur.title === '뉴스끝') return
    setRundownSafe((prev) => {
      const items = [...prev.items]
      ;[items[target], items[idx]] = [items[idx]!, items[target]!]
      return { ...prev, items }
    })
    setFocusItemId(cur.id)
  }

  function takeOutToAfterEnd() {
    if (!rundown || selectedIndex == null || !selectedItemId) return
    if (isItemLockedDuringPlay(selectedItemId, play, includedRows)) return
    const idx = selectedIndex
    const cur = rundown.items[idx]
    if (!cur) return
    if (cur.kind === 'marker' && cur.title === '뉴스끝') return
    setRundownSafe((prev) => {
      const endIdx = prev.items.findIndex((x) => x.kind === 'marker' && x.title === '뉴스끝')
      if (endIdx < 0) return prev
      const items = [...prev.items]
      const [picked] = items.splice(idx, 1)
      if (!picked) return prev
      const insertAt = endIdx < idx ? endIdx + 1 : endIdx + 0
      items.splice(insertAt + 1, 0, picked)
      // ensure excluded from calc even if later moved above accidentally
      if (picked.kind === 'newsItem') {
        const p = picked
        return { ...prev, items: items.map((x) => (x.id === p.id && x.kind === 'newsItem' ? { ...x, includeInRun: false } : x)) }
      }
      return { ...prev, items }
    })
    setFocusItemId(cur.kind === 'newsItem' ? cur.id : null)
  }

  function putBackBeforeEnd() {
    if (!rundown || selectedIndex == null || !selectedItemId) return
    if (isItemLockedDuringPlay(selectedItemId, play, includedRows)) return
    const idx = selectedIndex
    const cur = rundown.items[idx]
    if (!cur) return
    if (cur.kind === 'marker' && cur.title === '뉴스끝') return
    const isAfterEnd = selectedRow?.isAfterEnd === true
    if (!isAfterEnd) return
    setRundownSafe((prev) => {
      const endIdx = prev.items.findIndex((x) => x.kind === 'marker' && x.title === '뉴스끝')
      if (endIdx < 0) return prev
      const items = [...prev.items]
      const [picked] = items.splice(idx, 1)
      if (!picked) return prev
      const insertAt = endIdx < idx ? endIdx : endIdx
      items.splice(insertAt, 0, picked)
      if (picked.kind === 'newsItem') {
        const p = picked
        return { ...prev, items: items.map((x) => (x.id === p.id && x.kind === 'newsItem' ? { ...x, includeInRun: true } : x)) }
      }
      return { ...prev, items }
    })
    setFocusItemId(cur.kind === 'newsItem' ? cur.id : null)
  }

  const computed = useMemo(() => {
    if (!rundown) return null
    return computeRundown(rundown)
  }, [rundown])

  const includedRows = useMemo(() => {
    if (!computed) return []
    return computed.rows.filter(
      (r) =>
        r.isIncluded &&
        (r.item.kind === 'newsItem' || r.item.kind === 'sectionHeader') &&
        r.item.includeInRun,
    ) as Array<
      (typeof computed.rows)[number] & { item: Extract<RundownItem, { kind: 'newsItem' | 'sectionHeader' }> }
    >
  }, [computed])

  const lastIncludedPlayIndex = Math.max(0, includedRows.length - 1)

  const currentPlayingIdRef = useRef<string | null>(null)
  currentPlayingIdRef.current =
    play.state !== 'idle' && includedRows[play.currentIncludedIndex]
      ? includedRows[play.currentIncludedIndex]!.item.id
      : null

  const selectedRow = useMemo(() => {
    if (!computed || !selectedItemId) return null
    return computed.rows.find((r) => r.item.id === selectedItemId) ?? null
  }, [computed, selectedItemId])

  // Auto-advance engine
  useEffect(() => {
    if (advanceMode !== 'auto') return
    if (play.state !== 'running') return
    const t = window.setInterval(() => {
      setPlay((prev) => {
        if (prev.state !== 'running') return prev
        if (prev.resumeAfterBack) return prev
        const now = Date.now()

        // If we have nothing to play, stay idle
        if (includedRows.length === 0) {
          return { ...idlePlaySession(), elapsedByItemIdMs: prev.elapsedByItemIdMs }
        }

        let idx = Math.min(prev.currentIncludedIndex, includedRows.length - 1)
        let itemStartedAtMs = prev.itemStartedAtMs ?? now

        // Skip zero-duration items immediately
        let guard = 0
        while (guard < includedRows.length) {
          const dur = includedRows[idx]?.item.durationSeconds ?? 0
          if (dur > 0) break
          idx += 1
          itemStartedAtMs = now
          if (idx >= includedRows.length) {
            return { ...idlePlaySession(), elapsedByItemIdMs: prev.elapsedByItemIdMs }
          }
          guard += 1
        }

        const dur = includedRows[idx]?.item.durationSeconds ?? 0
        const elapsedMs = Math.max(0, now - itemStartedAtMs - prev.pausedAccumulatedMs)
        if (dur > 0 && elapsedMs >= dur * 1000) {
          // Cache elapsed for the item we are leaving (supports "go back" restore).
          const leaving = includedRows[idx]?.item
          const nextElapsedByItemIdMs =
            leaving && leaving.id
              ? { ...prev.elapsedByItemIdMs, [leaving.id]: Math.max(0, elapsedMs) }
              : prev.elapsedByItemIdMs
          const nextIdx = idx + 1
          if (nextIdx >= includedRows.length) {
            return {
              ...idlePlaySession(),
              elapsedByItemIdMs: nextElapsedByItemIdMs,
            }
          }
          const nextItemId = includedRows[nextIdx]!.item.id
          const savedElapsed = nextElapsedByItemIdMs[nextItemId] ?? 0
          return {
            ...prev,
            currentIncludedIndex: nextIdx,
            itemStartedAtMs: now - Math.max(0, savedElapsed),
            pausedAccumulatedMs: 0,
            pausedAtMs: null,
            elapsedByItemIdMs: nextElapsedByItemIdMs,
          }
        }

        if (idx !== prev.currentIncludedIndex || itemStartedAtMs !== prev.itemStartedAtMs) {
          return { ...prev, currentIncludedIndex: idx, itemStartedAtMs }
        }

        return prev
      })
    }, 200)
    return () => window.clearInterval(t)
  }, [advanceMode, play.state, includedRows])

  function setRundownSafe(updater: (prev: Rundown) => Rundown) {
    setRundown((prev) => {
      if (!prev) return prev
      const updated = updater(prev)
      if (playStateRef.current !== 'idle' && updated.items !== prev.items) {
        itemEditedDuringPlayRef.current = true
      }
      const next = { ...updated, updatedAt: new Date().toISOString() }
      localStorage.setItem(storageKeyForRundown(next.programId as ProgramId), JSON.stringify(next))
      return next
    })
  }

  function tryLoadFromStorage(pId: ProgramId) {
    const raw = localStorage.getItem(storageKeyForRundown(pId))
    if (!raw) return false
    try {
      const parsed = JSON.parse(raw) as Rundown
      if (parsed?.type !== 'rundown') return false
      if (parsed?.programId !== pId) return false
      setProgramId(pId)
      setRundown(normalizeRundown(parsed))
      setPlay(idlePlaySession())
      return true
    } catch {
      return false
    }
  }

  function loadTemplateFromStorage(pId: ProgramId): Template | null {
    const raw = localStorage.getItem(storageKeyForTemplate(pId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Template
      if (parsed?.type !== 'template') return null
      if (parsed?.programId !== pId) return null
      return normalizeTemplate(parsed)
    } catch {
      return null
    }
  }

  async function loadTemplateFromPublic(pId: ProgramId): Promise<Template | null> {
    try {
      const res = await fetch(`/templates/${encodeURIComponent(pId)}.template.json`, { cache: 'no-store' })
      if (!res.ok) return null
      const parsed = (await res.json()) as Template
      if (parsed?.type !== 'template') return null
      if (parsed?.programId !== pId) return null
      return normalizeTemplate(parsed)
    } catch {
      return null
    }
  }


  async function onPickProgram(p: ProgramDef) {
    // B안: 프로그램 선택 화면 → 동일 메인 화면.
    // PDF 불러오기·마지막 작업 등으로 저장된 큐시트가 있으면 우선 복원한다.
    if (tryLoadFromStorage(p.id)) {
      setSelectedItemId(null)
      return
    }

    // 요구사항: "템플릿 저장"을 해두면 열 때마다 템플릿이 자동으로 열린다.
    const storedTemplate = loadTemplateFromStorage(p.id)
    if (storedTemplate) {
      const rd = cloneTemplateToRundown(normalizeTemplate(storedTemplate))
      setProgramId(p.id)
      setRundown(rd)
      localStorage.setItem(storageKeyForRundown(p.id), JSON.stringify(rd))
      setPlay(idlePlaySession())
      setSelectedItemId(null)
      return
    }

    // If no saved template, try loading default templates committed to GitHub (served via public/ on Vercel).
    const publicTemplate = await loadTemplateFromPublic(p.id)
    if (publicTemplate) {
      localStorage.setItem(storageKeyForTemplate(p.id), JSON.stringify(publicTemplate))
      const rd = cloneTemplateToRundown(publicTemplate)
      setProgramId(p.id)
      setRundown(rd)
      localStorage.setItem(storageKeyForRundown(p.id), JSON.stringify(rd))
      setPlay(idlePlaySession())
      setSelectedItemId(null)
      return
    }

    // Fallback to built-in TS template if provided.
    if (p.template) {
      localStorage.setItem(storageKeyForTemplate(p.id), JSON.stringify(p.template))
      const rd = cloneTemplateToRundown(p.template)
      setProgramId(p.id)
      setRundown(rd)
      localStorage.setItem(storageKeyForRundown(p.id), JSON.stringify(rd))
      setPlay(idlePlaySession())
      setSelectedItemId(null)
      return
    }

    // 템플릿이 없으면 "빈 큐시트"로 시작
    const empty = createEmptyRundown(p)
    setProgramId(p.id)
    setRundown(empty)
    localStorage.setItem(storageKeyForRundown(p.id), JSON.stringify(empty))
    setPlay(idlePlaySession())
    setSelectedItemId(null)
  }

  function applyImportedRundown(parsed: Rundown, targetProgramId: ProgramId) {
    const pName = programs.find((p) => p.id === targetProgramId)?.name ?? parsed.programName
    const merged: Rundown = {
      ...parsed,
      programId: targetProgramId,
      programName: pName,
    }
    const normalized = normalizeRundown(merged)
    setProgramId(targetProgramId)
    setRundown(normalized)
    persistRundownAndTemplate(normalized, targetProgramId)
    setPlay(idlePlaySession())
    setSelectedItemId(null)
    requestAnimationFrame(() => {
      tableScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }

  async function onImportRundownFile(file: File) {
    const parsed = await readJsonFile<Rundown>(file)
    if (parsed.type !== 'rundown') {
      throw new Error('이 파일은 큐시트(rundown) 형식이 아닙니다.')
    }
    applyImportedRundown(parsed, parsed.programId as ProgramId)
  }

  async function onImportPdfFile(file: File) {
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) {
      throw new Error('PDF 큐시트 파일만 불러올 수 있습니다.')
    }

    const targetProgramId = (programId ?? guessProgramIdFromPdfName(file.name)) as ProgramId
    const targetName = programs.find((p) => p.id === targetProgramId)?.name

    setPdfImportBusy(true)
    try {
      const parsed = await parsePdfToRundown(file, {
        programId: targetProgramId,
        programName: targetName,
      })
      const preview = normalizeRundown({
        ...parsed,
        programId: targetProgramId,
        programName: targetName ?? parsed.programName,
      })
      const { includedTotalSeconds, deltaSeconds, budgetSeconds } = computeRundown(preview)
      const newsCount = preview.items.filter(
        (it) => it.kind === 'newsItem' && isArticleCategory(it.category),
      ).length
      const structCount = preview.items.filter(
        (it) => it.kind === 'newsItem' && !isArticleCategory(it.category),
      ).length
      const timedCount = preview.items.filter(
        (it) =>
          (it.kind === 'newsItem' || it.kind === 'sectionHeader') && it.durationSeconds > 0,
      ).length
      const spareCount = preview.items.filter(
        (it) => it.kind === 'newsItem' && it.flags.includes('spare') && it.includeInRun,
      ).length
      const ok = confirm(
        [
          `PDF 큐시트를 읽었습니다.`,
          ``,
          `파일: ${file.name}`,
          `방송일: ${preview.broadcastDate}`,
          `편성: ${formatSeconds(budgetSeconds)} · 본편 합계: ${formatSeconds(includedTotalSeconds)}`,
          `편성대비: ${formatDelta(deltaSeconds)}`,
          `완제/단신 ${newsCount}건 · 오프닝·CM 등 ${structCount}건 · 시간 있는 행 ${timedCount}개`,
          `뉴스끝 이후 예비 ${spareCount}건`,
          `전체 표시 행 ${preview.items.length}개 (빈줄·섹션·뉴스끝 포함)`,
          ``,
          `적용 시 템플릿에도 저장되어, 프로그램을 다시 열어도 이 큐시트가 유지됩니다.`,
          `현재 프로그램(${targetName ?? targetProgramId})에 적용할까요?`,
        ].join('\n'),
      )
      if (!ok) return
      applyImportedRundown(preview, targetProgramId)
    } finally {
      setPdfImportBusy(false)
    }
  }

  async function onImportJsonFile(file: File) {
    const parsed = await readJsonFile<any>(file)
    if (parsed?.type === 'rundown') {
      await onImportRundownFile(file)
      return
    }
    if (parsed?.type === 'template') {
      const t = normalizeTemplate(parsed as Template)
      // 현재 열려 있는 프로그램에 아이템을 적용 (programId 불일치 허용)
      const targetPId = programId ?? (t.programId as ProgramId)
      const targetName = programs.find((p) => p.id === targetPId)?.name ?? t.programName
      // 현재 프로그램 기준으로 rundown 구성 (아이템만 그대로 가져옴)
      const rd: Rundown = {
        ...cloneTemplateToRundown(t),
        programId: targetPId,
        programName: targetName,
      }
      setProgramId(targetPId)
      setRundown(rd)
      localStorage.setItem(storageKeyForRundown(targetPId), JSON.stringify(rd))
      // 현재 프로그램용 템플릿으로도 저장
      const savedTemplate: Template = { ...t, programId: targetPId, programName: targetName }
      localStorage.setItem(storageKeyForTemplate(targetPId), JSON.stringify(savedTemplate))
      setPlay(idlePlaySession())
      setSelectedItemId(null)
      return
    }
    if (parsed?.type === 'templatesBundle' && Array.isArray(parsed?.templates)) {
      const templates = parsed.templates as Template[]
      const addedPrograms: ProgramDef[] = []
      for (const t0 of templates) {
        if (!t0 || t0.type !== 'template') continue
        const t = normalizeTemplate(t0)
        const pId = String(t.programId)
        localStorage.setItem(storageKeyForTemplate(pId), JSON.stringify(t))
        if (!programs.some((p) => p.id === pId)) {
          addedPrograms.push({ id: pId, name: t.programName || pId, builtIn: false })
        }
      }
      if (addedPrograms.length > 0) {
        const next = [...programs, ...addedPrograms]
        setPrograms(next)
        persistCustomPrograms(next)
      }
      alert(`템플릿 ${templates.length}개를 로컬에 저장했습니다.`)
      return
    }
    throw new Error('지원하지 않는 파일 형식입니다. (rundown/template JSON만 가능)')
  }

  function persistRundownAndTemplate(rd: Rundown, pId: ProgramId) {
    localStorage.setItem(storageKeyForRundown(pId), JSON.stringify(rd))
    localStorage.setItem(storageKeyForTemplate(pId), JSON.stringify(rundownToTemplate(rd)))
  }

  function saveCurrentAsTemplate() {
    if (!rundown || !programId) return
    persistRundownAndTemplate(rundown, programId)
    alert('이 큐시트를 템플릿으로 저장했습니다. 다음에 프로그램을 열면 자동으로 이 템플릿이 열립니다.')
  }

  function exitToProgramSelect() {
    if (rundown && programId) {
      let rd = rundown
      if (hasPlaybackDurationData(play)) {
        const includedIds = includedRows.map((r) => r.item.id)
        rd = applyActualDurationsFromPlay(rundown, play, includedIds)
      }
      persistRundownAndTemplate(rd, programId)
    }
    setProgramId(null)
    setRundown(null)
    setSelectedItemId(null)
    setPlay(idlePlaySession())
  }

  function loadLastRundownSession(pId: ProgramId) {
    if (tryLoadFromStorage(pId)) return
    alert('저장된 마지막 작업이 없습니다.')
  }

  function startNewsNow() {
    if (!rundown) return
    const clock = nowClockHHMMSS()
    setRundownSafe((prev) => ({
      ...prev,
      timing: { ...prev.timing, newsStartTime: clock },
    }))
    setNewsStartDraft(clock)
    const now = Date.now()
    // Compute start index from the rundown itself to avoid stale derived lists.
    const runnable = includedRows.map((r) => r.item)
    let firstIdx = 0
    for (let i = 0; i < runnable.length; i += 1) {
      const dur = runnable[i]?.durationSeconds ?? 0
      if (dur > 0) {
        firstIdx = i
        break
      }
    }
    const startIncludedIdx = Math.min(firstIdx, Math.max(0, runnable.length - 1))
    const firstItem = runnable[startIncludedIdx]
    setPlay({
      state: 'running',
      currentIncludedIndex: startIncludedIdx,
      itemStartedAtMs: now,
      pausedAtMs: null,
      pausedAccumulatedMs: 0,
      elapsedByItemIdMs: {},
      plannedDurationSecondsByItemId: snapshotPlannedDurationIfNeeded({}, firstItem),
      newsStartedAtMs: now,
      resumeAfterBack: null,
    })
    // start at top before auto-follow kicks in
    window.requestAnimationFrame(() => {
      tableScrollRef.current?.scrollTo({ top: 0 })
    })
  }

  function togglePause() {
    setPlay((prev) => {
      if (prev.state === 'idle') return prev
      if (prev.state === 'running') {
        return { ...prev, state: 'paused', pausedAtMs: Date.now() }
      }
      // paused -> running
      const now = Date.now()
      const pausedFor = prev.pausedAtMs ? now - prev.pausedAtMs : 0
      return {
        ...prev,
        state: 'running',
        pausedAtMs: null,
        pausedAccumulatedMs: prev.pausedAccumulatedMs + pausedFor,
      }
    })
  }

  function moveToIncludedIndex(
    targetIncludedIndex: number,
    opts?: { commitDuration?: boolean; resumeAfterBack?: ResumeAfterBack | null },
  ) {
    const now = Date.now()
    const commitDuration = opts?.commitDuration === true

    setPlay((prev) => {
      if (includedRows.length === 0) return prev

      const clamped = Math.max(0, Math.min(targetIncludedIndex, includedRows.length))
      const returningToResume =
        prev.resumeAfterBack != null && clamped === prev.resumeAfterBack.includedIndex

      // Save current item's elapsed before switching.
      let nextElapsedByItemIdMs = prev.elapsedByItemIdMs
      if (prev.state !== 'idle' && includedRows.length > 0) {
        const curIdx = Math.min(prev.currentIncludedIndex, includedRows.length - 1)
        const cur = includedRows[curIdx]?.item
        const isLeavingReviewForResume =
          returningToResume && prev.resumeAfterBack != null && curIdx < prev.resumeAfterBack.includedIndex
        if (cur && !isLeavingReviewForResume) {
          const elapsedMs = currentElapsedMsForPlaySession(now, prev)
          nextElapsedByItemIdMs = { ...nextElapsedByItemIdMs, [cur.id]: elapsedMs }
          if (commitDuration && (cur.kind === 'newsItem' || cur.kind === 'sectionHeader')) {
            const nextDuration = Math.max(0, Math.floor(elapsedMs / 1000))
            setRundownSafe((r) => ({
              ...r,
              items: r.items.map((x) =>
                x.id === cur.id && (x.kind === 'newsItem' || x.kind === 'sectionHeader') ? { ...x, durationSeconds: nextDuration } : x,
              ),
            }))
          }
        }
      }

      const nextResumeAfterBack =
        opts?.resumeAfterBack !== undefined ? opts.resumeAfterBack : prev.resumeAfterBack

      if (clamped >= includedRows.length) {
        return {
          ...idlePlaySession(),
          elapsedByItemIdMs: nextElapsedByItemIdMs,
        }
      }

      const landingItem = includedRows[clamped]?.item
      const nextPlannedDurationSecondsByItemId = snapshotPlannedDurationIfNeeded(
        prev.plannedDurationSecondsByItemId,
        landingItem,
      )
      const nextItemId = includedRows[clamped]!.item.id
      const savedElapsed = nextElapsedByItemIdMs[nextItemId] ?? 0
      const startedAt = now - Math.max(0, savedElapsed)
      return {
        ...prev,
        state: 'running',
        currentIncludedIndex: clamped,
        itemStartedAtMs: startedAt,
        pausedAtMs: null,
        pausedAccumulatedMs: 0,
        elapsedByItemIdMs: nextElapsedByItemIdMs,
        plannedDurationSecondsByItemId: nextPlannedDurationSecondsByItemId,
        resumeAfterBack: nextResumeAfterBack,
      }
    })
  }

  function nextItemNow() {
    if (play.state === 'idle') return
    itemEditedDuringPlayRef.current = false
    if (play.resumeAfterBack) {
      moveToIncludedIndex(play.resumeAfterBack.includedIndex, { commitDuration: false, resumeAfterBack: null })
      return
    }
    if (play.currentIncludedIndex >= lastIncludedPlayIndex) return
    moveToIncludedIndex(play.currentIncludedIndex + 1, { commitDuration: true })
  }

  function prevItemNow() {
    if (play.state === 'idle' || play.resumeAfterBack) return
    const curIdx = play.currentIncludedIndex
    if (curIdx <= 0) return
    const cur = includedRows[curIdx]?.item
    if (!cur) return
    moveToIncludedIndex(curIdx - 1, {
      commitDuration: false,
      resumeAfterBack: { includedIndex: curIdx, itemId: cur.id },
    })
  }

  const startNewsNowRef = useRef(startNewsNow)
  const nextItemNowRef = useRef(nextItemNow)
  const togglePauseRef = useRef(togglePause)
  startNewsNowRef.current = startNewsNow
  nextItemNowRef.current = nextItemNow
  togglePauseRef.current = togglePause
  playStateRef.current = play.state

  useEffect(() => {
    if (play.state === 'idle') itemEditedDuringPlayRef.current = false
  }, [play.state])

  useEffect(() => {
    const touch = (e: Event) => {
      if (e instanceof KeyboardEvent && (e.code === 'Space' || e.key === ' ')) return
      lastUserActivityAtMsRef.current = Date.now()
    }
    const events = ['mousedown', 'keydown', 'input', 'change', 'touchstart'] as const
    for (const ev of events) window.addEventListener(ev, touch, { capture: true })
    return () => {
      for (const ev of events) window.removeEventListener(ev, touch, { capture: true })
    }
  }, [])

  // 5초 무반응 시 선택·포커스를 현재 진행 아이템으로 되돌림
  useEffect(() => {
    if (play.state === 'idle') return
    const tick = window.setInterval(() => {
      if (playStateRef.current === 'idle') return
      if (Date.now() - lastUserActivityAtMsRef.current < SPACE_ADVANCE_IDLE_MS) return
      const playingId = currentPlayingIdRef.current
      if (!playingId) return
      setSelectedItemId((prev) => (prev === playingId ? prev : playingId))
      const ae = document.activeElement
      if (isEditableKeyboardTarget(ae) && ae instanceof HTMLElement) ae.blur()
    }, 400)
    return () => window.clearInterval(tick)
  }, [play.state, play.currentIncludedIndex, includedRows.length])

  useEffect(() => {
    autoStartLatchRef.current = null
  }, [rundown?.timing.newsStartTime, rundown?.broadcastDate])

  useEffect(() => {
    if (!rundown || rundown.timing.autoStartAtNewsTime === false) return
    if (play.state !== 'idle') return
    const target = rundown.timing.newsStartTime
    const now = nowClockHHMMSS()
    const latchKey = `${rundown.broadcastDate}-${target}`
    if (now === target && autoStartLatchRef.current !== latchKey) {
      autoStartLatchRef.current = latchKey
      startNewsNowRef.current()
    }
  }, [nowMs, rundown, play.state])

  useEffect(() => {
    if (!rundown) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.repeat) return

      const now = Date.now()
      const idleMs = now - lastUserActivityAtMsRef.current
      const atEndOfMain =
        playStateRef.current !== 'idle' &&
        includedRows.length > 0 &&
        play.currentIncludedIndex >= lastIncludedPlayIndex
      const forceNext =
        playStateRef.current !== 'idle' &&
        itemEditedDuringPlayRef.current &&
        !atEndOfMain &&
        idleMs >= SPACE_ADVANCE_IDLE_MS

      if (forceNext) {
        e.preventDefault()
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        itemEditedDuringPlayRef.current = false
        lastUserActivityAtMsRef.current = now
        nextItemNowRef.current()
        return
      }

      if (isEditableKeyboardTarget(e.target)) return
      e.preventDefault()
      lastUserActivityAtMsRef.current = now
      if (play.state === 'idle') {
        startNewsNowRef.current()
      } else if (play.state === 'running') {
        nextItemNowRef.current()
      } else if (play.state === 'paused') {
        togglePauseRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [rundown, play.state, play.currentIncludedIndex, lastIncludedPlayIndex, includedRows.length])

  // Auto-follow: must be declared before any conditional return
  const currentPlayingIdForFollow =
    play.state !== 'idle' && includedRows[play.currentIncludedIndex] ? includedRows[play.currentIncludedIndex]!.item.id : null

  // Scroll once when the playing item changes — never override manual scroll.
  useEffect(() => {
    if (play.state === 'idle') return
    if (!currentPlayingIdForFollow) return

    const raf = window.requestAnimationFrame(() => {
      const el = document.getElementById(`row-${currentPlayingIdForFollow}`) as HTMLElement | null
      if (!el) return
      const container = (el.closest('.tableScroll') as HTMLDivElement | null) ?? tableScrollRef.current
      if (!container) return
      if (container.scrollHeight <= container.clientHeight + 2) return

      // Position current item at 3/4 down from the top of the visible area.
      const targetTop = el.offsetTop - container.clientHeight * (3 / 4) + el.offsetHeight / 2
      const clamped = Math.max(0, Math.min(targetTop, container.scrollHeight - container.clientHeight))
      container.scrollTop = clamped
    })

    return () => window.cancelAnimationFrame(raf)
  }, [currentPlayingIdForFollow])

  if (!rundown || !computed || !programId) {
    return (
      <div className="appShell">
        <div className="topBar">
          <div className="brand">
            <div className="brandTitle">뉴스진행</div>
            <div className="brandSub">Newstimekeeper (MVP)</div>
          </div>
        </div>
        <div className="page">
          <div className="card">
            <div className="cardTitle">프로그램 선택</div>
            <div className="programGrid">
              {programs.map((p) => (
                <button key={p.id} className="programBtn" onClick={() => void onPickProgram(p)}>
                  <div className="programName">{p.name}</div>
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
              <input
                className="input"
                placeholder="새 프로그램 이름"
                value={newProgramNameDraft}
                onChange={(e) => setNewProgramNameDraft(e.target.value)}
                style={{ maxWidth: 220 }}
              />
              <button
                className="btn"
                onClick={() => {
                  const name = newProgramNameDraft.trim()
                  if (!name) {
                    alert('프로그램 이름을 입력해 주세요.')
                    return
                  }
                  const existing = new Set(programs.map((p) => p.id))
                  const id = autoProgramId(name, existing)
                  const next = [...programs, { id, name, builtIn: false }]
                  setPrograms(next)
                  persistCustomPrograms(next)
                  setNewProgramNameDraft('')
                }}
              >
                프로그램 추가
              </button>
              <div className="hint">추가된 프로그램은 로컬에 저장됩니다.</div>
            </div>
            <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn subtle"
                onClick={() => {
                  const first = programs[0]
                  if (!first) return
                  loadLastRundownSession(first.id)
                }}
                title="(임시) 마지막 작업 불러오기"
              >
                마지막 작업 불러오기(임시)
              </button>
              <button
                className="btn"
                onClick={() => {
                  if (!fileInputRef.current) return
                  fileInputRef.current.value = ''
                  fileInputRef.current.click()
                }}
              >
                큐시트 불러오기(JSON)
              </button>
              <div className="hint">로컬스토리지에 이전 작업이 있으면 자동 복원됩니다.</div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0]
                if (!f) return
                try {
                  await onImportJsonFile(f)
                } catch (err) {
                  alert(err instanceof Error ? err.message : '불러오기에 실패했습니다.')
                }
              }}
            />
            <input
              ref={templatesFileInputRef}
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0]
                if (!f) return
                try {
                  await onImportJsonFile(f)
                } catch (err) {
                  alert(err instanceof Error ? err.message : '불러오기에 실패했습니다.')
                }
              }}
            />
          </div>
        </div>
      </div>
    )
  }

  const budgetSeconds = computed.budgetSeconds
  const isEndClockBudget = rundown.timing.budgetMode === 'endClock'
  // 편성대비 = 뉴스합계 − 예산(편성시간 또는 끝−시작)
  const scheduleDeltaSeconds = computed.deltaSeconds
  const liveProgressSeconds = displayedNewsProgressSeconds(play, nowMs)
  const liveBasisSeconds = play.state === 'idle' ? computed.includedTotalSeconds : liveProgressSeconds
  const liveRemainingSeconds = budgetSeconds - liveBasisSeconds

  const currentPlayingId =
    play.state !== 'idle' && includedRows[play.currentIncludedIndex] ? includedRows[play.currentIncludedIndex]!.item.id : null
  // IMPORTANT: Do not introduce hooks below the conditional return above.
  // This derived value is cheap enough to compute inline.
  const isSelectedItemLocked =
    selectedItemId != null && isItemLockedDuringPlay(selectedItemId, play, includedRows)

  return (
    <div className="appShell">
      <div className="topBar">
        <div className="brand">
          <div className="brandTitle">{rundown.programName}</div>
          <div className="brandSub">{rundown.broadcastDate}</div>
        </div>

        <div className="metrics">
          <div className="metric metricNewsStart">
            <div className="metricLabelRow">
              <div className="label">뉴스 시작</div>
              <label className="autoStartCheck" title="설정한 뉴스 시작 시각에 자동 재생">
                <input
                  type="checkbox"
                  checked={rundown.timing.autoStartAtNewsTime !== false}
                  onChange={(e) => {
                    setRundownSafe((prev) => ({
                      ...prev,
                      timing: { ...prev.timing, autoStartAtNewsTime: e.target.checked },
                    }))
                  }}
                />
                <span>자동</span>
              </label>
            </div>
            <div className="value mono">{rundown.timing.newsStartTime}</div>
          </div>
          <div className="metric">
            <div className="label">진행시간</div>
            <div className="value mono">{formatSeconds(liveProgressSeconds)}</div>
          </div>
          <div className="metric">
            <div className="label">남은 시간</div>
            <div className="value mono remainingAlways">{formatDelta(liveRemainingSeconds)}</div>
          </div>
          <div className="metric">
            <div className="label">편성대비</div>
            <div className={scheduleDeltaSeconds < 0 ? 'value mono ok' : scheduleDeltaSeconds > 0 ? 'value mono bad' : 'value mono'}>
              {formatDelta(scheduleDeltaSeconds)}
            </div>
          </div>
        </div>

        <div className="topActions">
          <span className="tag mono newsTotalTag" title="뉴스끝 이전, includeInRun=true인 전체 아이템(뉴스+섹션) 합계">
            <span className="tagMain">뉴스합계 {formatSeconds(computed.includedTotalSeconds)}</span>
            <span className="tagSub">
              {isEndClockBudget ? `끝 ${rundown.timing.newsEndTime}` : `편성 ${formatSeconds(budgetSeconds)}`}
            </span>
          </span>
          <button
            className="btn subtle"
            onClick={exitToProgramSelect}
            title="실제 진행 시간을 반영해 템플릿으로 저장한 뒤 프로그램 선택 화면으로 이동"
          >
            뉴스나가기
          </button>
          <button className="btn" onClick={saveCurrentAsTemplate} title="현재 큐시트를 템플릿으로 저장">
            템플릿 저장
          </button>
        </div>
      </div>

      <div className="page">
        <div className="panel rundownPanel">
          <div className="panelHeader">
            <div className="panelTitle">큐시트</div>
            <div className="panelMeta">
              <span className="tag mono">오차목표 ±{rundown.timing.toleranceSeconds}s</span>
              <span className="tag mono">행 {rundown.items.length}</span>
            </div>
          </div>

          <div className="table">
            <div className="thead">
              <div>순서</div>
              <div>구분</div>
              <div>기자</div>
              <div>제목</div>
              <div className="right">시작</div>
              <div className="right">남은 시간</div>
              <div className="right">조작</div>
            </div>

            {(() => {
              const rows = computed.rows
              const endIdx = rows.findIndex((r) => r.item.kind === 'marker' && r.item.title === '뉴스끝')
              const beforeEnd = endIdx >= 0 ? rows.slice(0, endIdx) : rows
              const endRow = endIdx >= 0 ? rows[endIdx] : null
              const afterEnd = endIdx >= 0 ? rows.slice(endIdx + 1) : []
              const effectiveNowForItem = play.state === 'paused' ? play.pausedAtMs ?? nowMs : nowMs
              const currentItemElapsedSeconds = rawItemElapsedSeconds(play, effectiveNowForItem)

              const plannedEndTime = computed.plannedEndTime
              let projectedEndTime: string | null = null
              if (play.state !== 'idle' && includedRows.length > 0) {
                const curIdx = Math.min(play.currentIncludedIndex, includedRows.length - 1)
                let projectedSeconds = 0
                for (let i = 0; i < includedRows.length; i += 1) {
                  const row = includedRows[i]!
                  if (i < curIdx) projectedSeconds += row.item.durationSeconds ?? 0
                  else if (i === curIdx) projectedSeconds += currentItemElapsedSeconds
                  else projectedSeconds += row.item.durationSeconds ?? 0
                }
                projectedEndTime = addSecondsToClock(rundown.timing.newsStartTime, projectedSeconds)
              }

              let displayNo = 0
              const renderRow = (row: (typeof rows)[number]) => {
                const it = row.item
                const isMarkerEnd = it.kind === 'marker' && it.title === '뉴스끝'
                const isAfterEnd = row.isAfterEnd
                const start = row.startTime ?? null
                const duration = it.kind === 'newsItem' || it.kind === 'sectionHeader' ? it.durationSeconds : 0
                const isCurrent = currentPlayingId != null && it.id === currentPlayingId
                const isLocked = isItemLockedDuringPlay(it.id, play, includedRows)
                let displayRemainingSeconds: number | null = null
                let displayRemainingTitle: string | undefined
                if (it.kind === 'newsItem' || it.kind === 'sectionHeader') {
                  const initialSec = play.plannedDurationSecondsByItemId[it.id]
                  if (isCurrent && initialSec != null) {
                    const actualSec = currentItemElapsedSeconds
                    displayRemainingSeconds = plannedVsActualRemainingSeconds(initialSec, actualSec)
                    displayRemainingTitle = `초기 ${formatSeconds(initialSec)} − 진행 ${formatSeconds(actualSec)}`
                  } else if (isLocked && play.state !== 'idle' && initialSec != null) {
                    const cachedMs = play.elapsedByItemIdMs[it.id]
                    if (cachedMs != null) {
                      const actualSec = Math.floor(cachedMs / 1000)
                      displayRemainingSeconds = plannedVsActualRemainingSeconds(initialSec, actualSec)
                      displayRemainingTitle = `초기 ${formatSeconds(initialSec)} − 진행 ${formatSeconds(actualSec)}`
                    }
                  }
                }
                const showDurationEditor = it.kind === 'newsItem' || it.kind === 'sectionHeader'
                const emphasis = it.kind === 'newsItem' ? it.isEmphasis : false
                const selected = selectedItemId != null && it.id === selectedItemId

                const orderLabel = (() => {
                  if (it.kind === 'newsItem') {
                    if (it.cueNo != null) return String(it.cueNo).padStart(2, '0')
                    if (isArticleCategory(it.category) && it.title.trim() !== '') {
                      displayNo += 1
                      return String(displayNo).padStart(2, '0')
                    }
                    return ''
                  }
                  if (it.kind === 'sectionHeader') return '§'
                  if (it.kind === 'blank') return '···'
                  return ''
                })()

                return (
                  <div
                    key={it.id}
                    id={`row-${it.id}`}
                    className={[
                      'tr',
                      it.kind,
                      isMarkerEnd ? 'markerEnd' : '',
                      isAfterEnd ? 'afterEnd' : '',
                      isCurrent ? 'current' : '',
                      emphasis ? 'emphasis' : '',
                      selected ? 'selected' : '',
                      isLocked ? 'locked' : '',
                    ].join(' ')}
                    onMouseDown={() => setSelectedItemId(it.id)}
                  >
                    <div className="mono orderCell" title={it.kind === 'newsItem' && it.cueNo != null ? `PDF ${it.cueNo}번` : undefined}>
                      {orderLabel}
                    </div>
                    <div>
                      {it.kind === 'newsItem' ? (
                        <select
                          className={['select', isBlankSlotCategory(it.category) ? 'selectBlankCategory' : '']
                            .filter(Boolean)
                            .join(' ')}
                          value={it.category}
                          disabled={isLocked}
                          title={
                            isLocked
                              ? '진행 완료 — 편집 불가'
                              : isBlankSlotCategory(it.category)
                                ? '구분 없음 · 시간만 입력'
                                : undefined
                          }
                          onChange={(e) => {
                            const v = e.target.value
                            setRundownSafe((prev) => ({
                              ...prev,
                              items: prev.items.map((x) =>
                                x.id === it.id && x.kind === 'newsItem'
                                  ? {
                                      ...x,
                                      category: v,
                                      ...(v === CATEGORY_BLANK
                                        ? {
                                            title: '',
                                            durationSeconds: defaultDurationForBlankSlot({
                                              notes: x.notes,
                                              reporter: x.reporter,
                                            }),
                                            includeInRun: true,
                                          }
                                        : { durationSeconds: defaultDurationForCategory(v) }),
                                    }
                                  : x,
                              ),
                            }))
                          }}
                        >
                          {CUE_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {categoryLabelForUi(c) || '\u00a0'}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="muted">{it.kind === 'marker' ? it.title : ''}</span>
                      )}
                    </div>
                    <div>
                      {it.kind === 'newsItem' ? (
                        <input
                          className="input"
                          value={it.reporter}
                          disabled={isLocked}
                          title={isLocked ? '진행 완료 — 편집 불가' : undefined}
                          onChange={(e) => {
                            const v = e.target.value
                            setRundownSafe((prev) => ({
                              ...prev,
                              items: prev.items.map((x) =>
                                x.id === it.id && x.kind === 'newsItem' ? { ...x, reporter: v } : x,
                              ),
                            }))
                          }}
                        />
                      ) : (
                        <span className="muted">{it.kind === 'marker' ? it.title : ''}</span>
                      )}
                    </div>
                    <div className="titleCell">
                      {it.kind === 'newsItem' ? (
                        <div className="titleWrap">
                          <input
                            className="input"
                            id={`title-${it.id}`}
                            value={it.title}
                            disabled={isLocked}
                            title={isLocked ? '진행 완료 — 편집 불가' : undefined}
                            onChange={(e) => {
                              const v = e.target.value
                              setRundownSafe((prev) => ({
                                ...prev,
                                items: prev.items.map((x) =>
                                  x.id === it.id && x.kind === 'newsItem' ? { ...x, title: v } : x,
                                ),
                              }))
                            }}
                          />
                          {it.isDefaultItem ? <span className="badge">기본</span> : null}
                          {isAfterEnd && it.kind === 'newsItem' && it.includeInRun ? (
                            <span className="badge reserve">예비</span>
                          ) : !it.includeInRun ? (
                            <span className="badge off">제외</span>
                          ) : null}
                          {isArticleNewsItem(it) ? (
                            <button
                              type="button"
                              className={`miniBtn articleOpenBtn ${it.article ? 'hasArticle' : ''}`}
                              disabled={isLocked}
                              title={
                                isLocked
                                  ? '진행 완료 — 편집 불가'
                                  : it.article
                                    ? '기사·길이 편집 (입력됨)'
                                    : '기사 입력 · 길이 측정'
                              }
                              onClick={(e) => {
                                e.stopPropagation()
                                setArticleEditorItemId(it.id)
                              }}
                            >
                              기사
                            </button>
                          ) : null}
                          <span className="durPill mono" title="길이(mm:ss)">
                            {formatSeconds(duration)}
                          </span>
                        </div>
                      ) : it.kind === 'sectionHeader' ? (
                        <div className="titleWrap">
                          <input
                            className="input"
                            id={`title-${it.id}`}
                            value={it.title}
                            disabled={isLocked}
                            title={isLocked ? '진행 완료 — 편집 불가' : undefined}
                            onChange={(e) => {
                              const v = e.target.value
                              setRundownSafe((prev) => ({
                                ...prev,
                                items: prev.items.map((x) =>
                                  x.id === it.id && x.kind === 'sectionHeader' ? { ...x, title: v } : x,
                                ),
                              }))
                            }}
                          />
                          <span className="durPill mono" title="길이(mm:ss)">
                            {formatSeconds(duration)}
                          </span>
                        </div>
                      ) : (
                        <span className="muted blankLabel">{it.kind === 'blank' ? '빈줄' : it.title}</span>
                      )}
                    </div>

                    <div className="right mono">
                      {isMarkerEnd ? (
                        <div className="endTimeStack">
                          <div className="endTimeLine" title="큐시트 합계 기준 예정 끝">
                            <span className="endTimeLabel">예정</span> {plannedEndTime}
                          </div>
                          {projectedEndTime && projectedEndTime !== plannedEndTime ? (
                            <div className="endTimeLine projected" title="현재 진행 반영 예상 끝">
                              <span className="endTimeLabel">예상</span> {projectedEndTime}
                            </div>
                          ) : null}
                          {play.state === 'idle' && isEndClockBudget ? (
                            <div className="endTimeLine target" title="목표 끝 시각">
                              <span className="endTimeLabel">목표</span> {rundown.timing.newsEndTime}
                            </div>
                          ) : null}
                        </div>
                      ) : start ? (
                        start
                      ) : (
                        ''
                      )}
                    </div>
                    <div
                      className={[
                        'right',
                        'mono',
                        'itemRemainingCell',
                        displayRemainingSeconds != null
                          ? displayRemainingSeconds > 0
                            ? 'ok'
                            : displayRemainingSeconds < 0
                              ? 'bad'
                              : ''
                          : '',
                      ].join(' ')}
                      title={displayRemainingTitle}
                    >
                      {displayRemainingSeconds != null ? formatDelta(displayRemainingSeconds) : ''}
                    </div>
                    <div className="right">
                      <div className="actions">
                        {it.kind === 'newsItem' ? (
                          <label className="emChk" title="글자 크게(+5pt)">
                            <input
                              type="checkbox"
                              checked={it.isEmphasis}
                              disabled={isLocked}
                              onChange={(e) => {
                                const checked = e.target.checked
                                setRundownSafe((prev) => ({
                                  ...prev,
                                  items: prev.items.map((x) =>
                                    x.id === it.id && x.kind === 'newsItem' ? { ...x, isEmphasis: checked } : x,
                                  ),
                                }))
                              }}
                            />
                          </label>
                        ) : null}
                        {showDurationEditor ? (
                          <DurationEditor
                            valueSeconds={duration}
                            disabled={isLocked}
                            onDelta={(d) => {
                              if (isLocked) return
                              setRundownSafe((prev) => ({
                                ...prev,
                                items: prev.items.map((x) =>
                                  x.id === it.id && (x.kind === 'newsItem' || x.kind === 'sectionHeader')
                                    ? { ...x, durationSeconds: Math.max(0, x.durationSeconds + d) }
                                    : x,
                                ),
                              }))
                            }}
                          />
                        ) : null}
                        {it.kind === 'newsItem' ? (
                          <button
                            className="iconBtn"
                            disabled={isLocked}
                            title={
                              isLocked
                                ? '진행 완료 — 편집 불가'
                                : it.includeInRun && !isAfterEnd
                                  ? '진행 제외'
                                  : '진행 포함'
                            }
                            onClick={() => {
                              if (isLocked) return
                              setRundownSafe((prev) => ({
                                ...prev,
                                items: prev.items.map((x) =>
                                  x.id === it.id && x.kind === 'newsItem' ? { ...x, includeInRun: !x.includeInRun } : x,
                                ),
                              }))
                            }}
                          >
                            {it.includeInRun ? '✓' : '⏸'}
                          </button>
                        ) : it.kind === 'sectionHeader' ? (
                          <button
                            className="iconBtn"
                            disabled={isLocked}
                            title={
                              isLocked
                                ? '진행 완료 — 편집 불가'
                                : it.includeInRun && !isAfterEnd
                                  ? '시간계산 제외'
                                  : '시간계산 포함'
                            }
                            onClick={() => {
                              if (isLocked) return
                              setRundownSafe((prev) => ({
                                ...prev,
                                items: prev.items.map((x) =>
                                  x.id === it.id && x.kind === 'sectionHeader' ? { ...x, includeInRun: !x.includeInRun } : x,
                                ),
                              }))
                            }}
                          >
                            {it.includeInRun ? '✓' : '⏸'}
                          </button>
                        ) : null}
                        {!isMarkerEnd ? (
                          <button
                            className="iconBtn danger"
                            disabled={isLocked}
                            title={isLocked ? '진행 완료 — 편집 불가' : '삭제'}
                            onClick={() => {
                              if (isLocked) return
                              setRundownSafe((prev) => ({
                                ...prev,
                                items: prev.items.filter((x) => x.id !== it.id),
                              }))
                            }}
                          >
                            ✕
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              }

              return (
                <>
                  <div
                    ref={tableScrollRef}
                    className="tableScroll"
                    style={{
                      paddingBottom: pinnedFooterHeight
                        ? pinnedFooterHeight + 48
                        : 120,
                    }}
                    onScroll={() => {
                      // follow toggle removed; keep behavior unchanged (no-op)
                    }}
                  >
                    {beforeEnd.map(renderRow)}
                    {endRow ? renderRow(endRow) : null}
                    {afterEnd.length > 0 ? (
                      <div className="tr cueDivider afterEndDivider" aria-hidden>
                        <div className="cueDividerLabel">뉴스끝 이후 · PDF 예비·서버 ({afterEnd.length}행)</div>
                      </div>
                    ) : null}
                    {afterEnd.map(renderRow)}

                    <div
                      ref={pinnedFooterRef}
                      className={['footerBar', 'pinnedFooter', 'pinnedFooterFixed', timingDraftDirty ? 'pinnedFooterDirty' : '']
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <button
                          className="btn"
                          disabled={pdfImportBusy}
                          onClick={() => {
                            if (!pdfFileInputRef.current) return
                            pdfFileInputRef.current.value = ''
                            pdfFileInputRef.current.click()
                          }}
                          title="MBC 뉴스 큐시트 PDF 불러오기"
                        >
                          {pdfImportBusy ? 'PDF 분석 중…' : '큐시트 불러오기 (PDF)'}
                        </button>
                        <span className="hint footerPdfHint">MBC 뉴스 큐시트 PDF · 적용 전 요약 확인</span>
                        <button
                          className="btn subtle"
                          disabled={!selectedItemId || isSelectedItemLocked}
                          onClick={() => moveSelected(-1)}
                          title="선택한 아이템 위로"
                        >
                          위로
                        </button>
                        <button
                          className="btn subtle"
                          disabled={!selectedItemId || isSelectedItemLocked}
                          onClick={() => moveSelected(1)}
                          title="선택한 아이템 아래로"
                        >
                          아래로
                        </button>
                        <button
                          className="btn subtle"
                          disabled={!selectedItemId || !!selectedRow?.isAfterEnd || isSelectedItemLocked}
                          onClick={takeOutToAfterEnd}
                          title="뉴스끝 아래로 빼기(시간계산 제외)"
                        >
                          빼기
                        </button>
                        <button
                          className="btn subtle"
                          disabled={!selectedItemId || !selectedRow?.isAfterEnd}
                          onClick={putBackBeforeEnd}
                          title="뉴스끝 바로 위로 넣기"
                        >
                          넣기
                        </button>
                        <button
                          className="btn"
                          onClick={() => {
                            const newItem: RundownItem = {
                              id: uid('i_'),
                              kind: 'newsItem',
                              category: '완제',
                              reporter: '',
                              title: '',
                              durationSeconds: 90,
                              notes: '',
                              isDefaultItem: false,
                              isEmphasis: false,
                              isTimeAdjust: false,
                              includeInRun: true,
                              flags: [],
                            }
                            setRundownSafe((prev) => ({
                              ...prev,
                              items: insertAfterSelectedOrBeforeEnd(prev.items, selectedItemId, newItem),
                            }))
                            setSelectedItemId(newItem.id)
                            setFocusItemId(newItem.id)
                          }}
                        >
                          아이템 추가
                        </button>
                        <button
                          className="btn subtle"
                          onClick={() => {
                            const blank: RundownItem = { id: uid('b_'), kind: 'blank', title: '', includeInRun: false }
                            setRundownSafe((prev) => ({
                              ...prev,
                              items: insertAfterSelectedOrBeforeEnd(prev.items, selectedItemId, blank),
                            }))
                            setSelectedItemId(blank.id)
                          }}
                        >
                          빈줄
                        </button>
                        <button
                          className="btn subtle blankSlotBtn"
                          title="앵커 교체·특이사항 — 구분·제목 없음, 앵커 기본 10초"
                          aria-label="구분 없는 행 추가"
                          onClick={() => {
                            const slot: RundownItem = {
                              id: uid('i_'),
                              kind: 'newsItem',
                              category: CATEGORY_BLANK,
                              reporter: '',
                              title: '',
                              durationSeconds: defaultDurationForBlankSlot({ notes: '앵커', reporter: '' }),
                              notes: '앵커',
                              isDefaultItem: false,
                              isEmphasis: false,
                              isTimeAdjust: false,
                              includeInRun: true,
                              flags: [],
                            }
                            setRundownSafe((prev) => ({
                              ...prev,
                              items: insertAfterSelectedOrBeforeEnd(prev.items, selectedItemId, slot),
                            }))
                            setSelectedItemId(slot.id)
                            setFocusItemId(slot.id)
                          }}
                        >
                          ''
                        </button>
                      </div>

                      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button
                          className="btn playToggle"
                          onClick={() => {
                            if (play.state === 'idle') startNewsNow()
                            else togglePause()
                          }}
                          title={play.state === 'idle' ? '현재 시간으로 뉴스 시작' : play.state === 'paused' ? '재개' : '포즈'}
                        >
                          {play.state === 'idle' ? '뉴스시작' : play.state === 'paused' ? '재개' : '포즈'}
                        </button>
                        <button
                          className="btn subtle"
                          onClick={prevItemNow}
                          disabled={play.state === 'idle' || play.currentIncludedIndex <= 0 || play.resumeAfterBack != null}
                          title={
                            play.resumeAfterBack
                              ? '한 번만 뒤로 갈 수 있습니다. 다음으로 원래 아이템 복귀'
                              : '이전 아이템으로 (1칸)'
                          }
                        >
                          이전 아이템
                        </button>
                        <button
                          className="btn bigNextBtn"
                          onClick={nextItemNow}
                          disabled={play.state === 'idle'}
                          title={play.resumeAfterBack ? '원래 진행 아이템으로 복귀' : '다음 아이템으로'}
                        >
                          {play.resumeAfterBack ? '원래 아이템' : '다음 아이템'}
                        </button>
                        <label className="field">
                          <span className="fieldLabel">진행모드</span>
                          <select
                            className="select"
                            value={advanceMode}
                            onChange={(e) => setAdvanceMode(e.target.value === 'manual' ? 'manual' : 'auto')}
                            title={advanceMode === 'auto' ? '시간이 끝나면 자동으로 다음으로 이동' : '다음 아이템을 눌러야 이동'}
                          >
                            <option value="auto">자동</option>
                            <option value="manual">수동</option>
                          </select>
                        </label>
                        <label className="field">
                          <span className="fieldLabel">뉴스 시작</span>
                          <input
                            className="input mono"
                            value={newsStartDraft}
                            onChange={(e) => {
                              setNewsStartDraft(e.target.value)
                            }}
                            onFocus={(e) => {
                              e.currentTarget.select()
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                applyTimingEdits()
                              }
                            }}
                          />
                        </label>
                        <label className="field">
                          <span className="fieldLabel">예산 기준</span>
                          <select
                            className="select"
                            value={rundown.timing.budgetMode}
                            onChange={(e) => {
                              const budgetMode = e.target.value === 'endClock' ? 'endClock' : 'scheduled'
                              setRundownSafe((prev) => ({
                                ...prev,
                                timing: { ...prev.timing, budgetMode },
                              }))
                            }}
                          >
                            <option value="scheduled">편성시간</option>
                            <option value="endClock">뉴스끝 시각</option>
                          </select>
                        </label>
                        <label className="field">
                          <span className="fieldLabel">편성(mm:ss)</span>
                          <input
                            className="input mono"
                            value={scheduledDraft}
                            disabled={isEndClockBudget}
                            title={isEndClockBudget ? '뉴스끝 시각 기준일 때는 끝−시작으로 자동 계산됩니다' : undefined}
                            onChange={(e) => {
                              setScheduledDraft(e.target.value)
                            }}
                            onFocus={(e) => {
                              e.currentTarget.select()
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                applyTimingEdits()
                              }
                            }}
                          />
                        </label>
                        <label className="field">
                          <span className="fieldLabel">뉴스끝</span>
                          <input
                            className="input mono"
                            value={newsEndDraft}
                            disabled={!isEndClockBudget}
                            title={!isEndClockBudget ? '예산 기준을 뉴스끝 시각으로 바꾸면 입력할 수 있습니다' : undefined}
                            onChange={(e) => {
                              setNewsEndDraft(e.target.value)
                            }}
                            onFocus={(e) => {
                              e.currentTarget.select()
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                applyTimingEdits()
                              }
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn timingApplyBtn"
                          disabled={!timingDraftDirty}
                          onClick={applyTimingEdits}
                          title="시작·편성·뉴스끝 시각을 큐시트에 반영"
                        >
                          적용
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )
            })()}
        </div>
      </div>
      </div>

      <input
        ref={pdfFileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.currentTarget.files?.[0]
          if (!f) return
          try {
            await onImportPdfFile(f)
          } catch (err) {
            alert(err instanceof Error ? err.message : 'PDF 불러오기에 실패했습니다.')
          }
        }}
      />

      {articleEditorItemId && rundown
        ? (() => {
            const editItem = rundown.items.find((x) => x.id === articleEditorItemId)
            if (!editItem || !isArticleNewsItem(editItem)) return null
            const locked = isItemLockedDuringPlay(editItem.id, play, includedRows)
            return (
              <ArticleEditorModal
                itemTitle={editItem.title}
                initial={editItem.article}
                disabled={locked}
                onClose={() => setArticleEditorItemId(null)}
                onApply={(article: ArticleScript, durationSeconds: number) => {
                  setRundownSafe((prev) => ({
                    ...prev,
                    items: prev.items.map((x) =>
                      x.id === editItem.id && x.kind === 'newsItem'
                        ? { ...x, article, durationSeconds: Math.max(0, durationSeconds) }
                        : x,
                    ),
                  }))
                }}
              />
            )
          })()
        : null}
    </div>
  )
}

function insertBeforeMarkerEnd(items: RundownItem[], newItem: RundownItem): RundownItem[] {
  const idx = items.findIndex((x) => x.kind === 'marker' && x.title === '뉴스끝')
  if (idx < 0) return [...items, newItem]
  const out = [...items]
  out.splice(idx, 0, newItem)
  return out
}

function DurationEditor(props: {
  valueSeconds: number
  disabled?: boolean
  onDelta: (deltaSeconds: number) => void
}) {
  const disabled = props.disabled === true
  return (
    <div className="dur">
      <div className="durBtns">
        <button className="miniBtn" disabled={disabled} onClick={() => props.onDelta(1)} title="+1초">
          +1
        </button>
        <button className="miniBtn" disabled={disabled} onClick={() => props.onDelta(5)}>
          +5
        </button>
        <button className="miniBtn" disabled={disabled} onClick={() => props.onDelta(10)}>
          +10
        </button>
        <button className="miniBtn" disabled={disabled} onClick={() => props.onDelta(-5)}>
          -5
        </button>
      </div>
    </div>
  )
}

function insertAfterSelectedOrBeforeEnd(
  items: RundownItem[],
  selectedId: string | null,
  newItem: RundownItem,
): RundownItem[] {
  if (!selectedId) return insertBeforeMarkerEnd(items, newItem)
  const idx = items.findIndex((x) => x.id === selectedId)
  if (idx < 0) return insertBeforeMarkerEnd(items, newItem)

  // if selected is 뉴스끝, still insert before it
  const selected = items[idx]
  if (selected?.kind === 'marker' && selected.title === '뉴스끝') {
    return insertBeforeMarkerEnd(items, newItem)
  }

  const out = [...items]
  out.splice(idx + 1, 0, newItem)
  return out
}

export default App
