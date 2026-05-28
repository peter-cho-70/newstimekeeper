import { useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import type { Rundown, RundownItem, Template } from './domain/types'
import { computeRundown, formatDelta, formatSeconds, parseTimeToSeconds } from './domain/time'
import { NEWS_ECONOMY_TEMPLATE, NEWS_EXTRA_TEMPLATE } from './templates'
import { downloadJson, readJsonFile } from './domain/file'
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
]

const PROGRAMS_KEY = 'newstimekeeper:programs:v1'

const DEFAULT_DURATION_BY_CATEGORY: Record<string, number> = {
  완제: 90,
  단신: 30,
  '': 0,
  공란: 0, // backward compat (older saved data)
}

function defaultDurationForCategory(category: string): number {
  return DEFAULT_DURATION_BY_CATEGORY[category] ?? 90
}

const STORAGE_KEY_PREFIX = 'newstimekeeper:rundown:v1:'
const TEMPLATE_KEY_PREFIX = 'newstimekeeper:template:v1:'

type PlayState = 'idle' | 'running' | 'paused'
type PlaySession = {
  state: PlayState
  currentIncludedIndex: number
  itemStartedAtMs: number | null
  pausedAtMs: number | null
  pausedAccumulatedMs: number
}

function storageKeyForRundown(programId: ProgramId) {
  return `${STORAGE_KEY_PREFIX}${programId}`
}
function storageKeyForTemplate(programId: ProgramId) {
  return `${TEMPLATE_KEY_PREFIX}${programId}`
}

type TemplatesBundle = {
  schemaVersion: string
  type: 'templatesBundle'
  templates: Template[]
}

function nowClockHHMMSS() {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

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
      toleranceSeconds: 15,
    },
    items: [marker],
  }
}

function normalizeRundown(r: Rundown): Rundown {
  return {
    ...r,
    items: r.items.map((it) => {
      if (it.kind === 'sectionHeader') {
        const dur = typeof (it as any).durationSeconds === 'number' ? (it as any).durationSeconds : 0
        return { ...it, durationSeconds: dur }
      }
      return it
    }),
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
      toleranceSeconds: 15,
    },
    items,
  }
}

function App() {
  const [programId, setProgramId] = useState<ProgramId | null>(null)
  const [rundown, setRundown] = useState<Rundown | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [focusItemId, setFocusItemId] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const pinnedFooterRef = useRef<HTMLDivElement | null>(null)
  const [pinnedFooterHeight, setPinnedFooterHeight] = useState<number>(0)
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const [play, setPlay] = useState<PlaySession>({
    state: 'idle',
    currentIncludedIndex: 0,
    itemStartedAtMs: null,
    pausedAtMs: null,
    pausedAccumulatedMs: 0,
  })

  const [newsStartDraft, setNewsStartDraft] = useState<string>('20:00:00')
  const [scheduledDraft, setScheduledDraft] = useState<string>('51:00')
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
    if (play.state === 'idle') return
    const t = window.setInterval(() => {
      setNowMs(Date.now())
    }, 200)
    return () => window.clearInterval(t)
  }, [play.state])

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
    setScheduledDraft(formatSeconds(rundown.timing.scheduledSeconds))
  }, [rundown?.timing.newsStartTime, rundown?.timing.scheduledSeconds])

  function moveSelected(delta: -1 | 1) {
    if (!rundown || selectedIndex == null) return
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
    if (!rundown || selectedIndex == null) return
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
    if (!rundown || selectedIndex == null) return
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
    return computed.rows.filter((r) => r.isIncluded && (r.item.kind === 'newsItem' || r.item.kind === 'sectionHeader')) as Array<
      (typeof computed.rows)[number] & { item: Extract<RundownItem, { kind: 'newsItem' | 'sectionHeader' }> }
    >
  }, [computed])

  const elapsedRunSeconds = useMemo(() => {
    if (play.state === 'idle') return 0
    if (includedRows.length === 0) return 0
    const idx = Math.min(play.currentIncludedIndex, includedRows.length - 1)
    const completed = includedRows.slice(0, idx).reduce((acc, r) => acc + (r.item.durationSeconds ?? 0), 0)

    const baseStartedAt = play.itemStartedAtMs ?? nowMs
    const effectiveNow = play.state === 'paused' ? play.pausedAtMs ?? nowMs : nowMs
    const elapsedMs = Math.max(0, effectiveNow - baseStartedAt - play.pausedAccumulatedMs)
    const currentDur = includedRows[idx]?.item.durationSeconds ?? 0
    const inCurrent = Math.min(currentDur, Math.floor(elapsedMs / 1000))
    return completed + inCurrent
  }, [includedRows, nowMs, play.currentIncludedIndex, play.itemStartedAtMs, play.pausedAccumulatedMs, play.pausedAtMs, play.state])

  const selectedRow = useMemo(() => {
    if (!computed || !selectedItemId) return null
    return computed.rows.find((r) => r.item.id === selectedItemId) ?? null
  }, [computed, selectedItemId])

  // Auto-advance engine
  useEffect(() => {
    if (play.state !== 'running') return
    const t = window.setInterval(() => {
      setPlay((prev) => {
        if (prev.state !== 'running') return prev
        const now = Date.now()

        // If we have nothing to play, stay idle
        if (includedRows.length === 0) {
          return { ...prev, state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 }
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
            return { ...prev, state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 }
          }
          guard += 1
        }

        const dur = includedRows[idx]?.item.durationSeconds ?? 0
        const elapsedMs = Math.max(0, now - itemStartedAtMs - prev.pausedAccumulatedMs)
        if (dur > 0 && elapsedMs >= dur * 1000) {
          const nextIdx = idx + 1
          if (nextIdx >= includedRows.length) {
            return { ...prev, state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 }
          }
          return { ...prev, currentIncludedIndex: nextIdx, itemStartedAtMs: now, pausedAccumulatedMs: 0, pausedAtMs: null }
        }

        if (idx !== prev.currentIncludedIndex || itemStartedAtMs !== prev.itemStartedAtMs) {
          return { ...prev, currentIncludedIndex: idx, itemStartedAtMs }
        }

        return prev
      })
    }, 200)
    return () => window.clearInterval(t)
  }, [play.state, includedRows])

  function setRundownSafe(updater: (prev: Rundown) => Rundown) {
    setRundown((prev) => {
      if (!prev) return prev
      const next = { ...updater(prev), updatedAt: new Date().toISOString() }
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
      setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
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

  async function loadPublicTemplatesIndex(): Promise<string[]> {
    try {
      const res = await fetch('/templates/index.json', { cache: 'no-store' })
      if (!res.ok) return []
      const parsed = (await res.json()) as any
      const ids = Array.isArray(parsed?.programIds) ? parsed.programIds : []
      return ids.filter((x: any) => typeof x === 'string')
    } catch {
      return []
    }
  }

  async function getAllKnownTemplateIds(): Promise<string[]> {
    const idsFromIndex = await loadPublicTemplatesIndex()
    const idsFromPrograms = programs.map((p) => p.id)
    const seen = new Set<string>()
    for (const id of [...idsFromIndex, ...idsFromPrograms]) {
      if (typeof id === 'string' && id.trim() !== '') seen.add(id)
    }
    return [...seen]
  }

  async function ensureAllTemplatesSavedToLocal() {
    const ids = await getAllKnownTemplateIds()
    let saved = 0
    for (const id of ids) {
      const already = loadTemplateFromStorage(id)
      if (already) continue
      const t = await loadTemplateFromPublic(id)
      if (t) {
        localStorage.setItem(storageKeyForTemplate(id), JSON.stringify(t))
        saved += 1
      }
    }
    alert(`템플릿을 모두 로컬에 저장했습니다. (추가 저장 ${saved}개)`)
  }

  async function importAllTemplatesFromPublic() {
    const ids = await getAllKnownTemplateIds()
    let imported = 0
    const addedPrograms: ProgramDef[] = []
    for (const id of ids) {
      const t = await loadTemplateFromPublic(id)
      if (!t) continue
      localStorage.setItem(storageKeyForTemplate(id), JSON.stringify(t))
      imported += 1
      if (!programs.some((p) => p.id === id)) {
        addedPrograms.push({ id, name: t.programName || id, builtIn: false })
      }
    }
    if (addedPrograms.length > 0) {
      const next = [...programs, ...addedPrograms]
      setPrograms(next)
      persistCustomPrograms(next)
    }
    alert(`템플릿을 모두 불러왔습니다. (${imported}개)`)
  }

  async function exportAllTemplates() {
    const ids = await getAllKnownTemplateIds()
    const templates: Template[] = []
    for (const id of ids) {
      const local = loadTemplateFromStorage(id)
      if (local) {
        templates.push(local)
        continue
      }
      const t = await loadTemplateFromPublic(id)
      if (t) templates.push(t)
    }
    const bundle: TemplatesBundle = { schemaVersion: '1.0', type: 'templatesBundle', templates }
    downloadJson(`templates_all_${new Date().toISOString().slice(0, 10)}.json`, bundle)
  }

  async function onPickProgram(p: ProgramDef) {
    // B안: 프로그램 선택 화면 → 동일 메인 화면.
    // 요구사항: "템플릿 저장"을 해두면 열 때마다 템플릿이 자동으로 열린다.
    const storedTemplate = loadTemplateFromStorage(p.id)
    if (storedTemplate) {
      const rd = cloneTemplateToRundown(normalizeTemplate(storedTemplate))
      setProgramId(p.id)
      setRundown(rd)
      localStorage.setItem(storageKeyForRundown(p.id), JSON.stringify(rd))
      setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
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
      setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
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
      setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
      setSelectedItemId(null)
      return
    }

    // 템플릿이 없으면 "빈 큐시트"로 시작
    const empty = createEmptyRundown(p)
    setProgramId(p.id)
    setRundown(empty)
    localStorage.setItem(storageKeyForRundown(p.id), JSON.stringify(empty))
    setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
    setSelectedItemId(null)
  }

  async function onImportRundownFile(file: File) {
    const parsed = await readJsonFile<Rundown>(file)
    if (parsed.type !== 'rundown') {
      throw new Error('이 파일은 큐시트(rundown) 형식이 아닙니다.')
    }
    setProgramId(parsed.programId as ProgramId)
    const normalized = normalizeRundown(parsed)
    setRundown(normalized)
    localStorage.setItem(storageKeyForRundown(parsed.programId as ProgramId), JSON.stringify(normalized))
    setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
    setSelectedItemId(null)
  }

  function exportRundown() {
    if (!rundown) return
    const filename = `rundown_${rundown.programId}_${rundown.broadcastDate || 'date'}_${uid('x_')}.json`
    downloadJson(filename, rundown)
  }

  function exportTemplate() {
    if (!rundown || !programId) return
    const t = rundownToTemplate(rundown)
    const filename = `template_${t.programId}_${uid('x_')}.json`
    downloadJson(filename, t)
  }

  async function onImportJsonFile(file: File) {
    const parsed = await readJsonFile<any>(file)
    if (parsed?.type === 'rundown') {
      await onImportRundownFile(file)
      return
    }
    if (parsed?.type === 'template') {
      const t = normalizeTemplate(parsed as Template)
      const pId = t.programId as ProgramId
      localStorage.setItem(storageKeyForTemplate(pId), JSON.stringify(t))
      // Apply immediately?
      if (confirm('템플릿을 저장했습니다. 지금 바로 이 템플릿으로 큐시트를 열까요?')) {
        const rd = cloneTemplateToRundown(t)
        setProgramId(pId)
        setRundown(rd)
        localStorage.setItem(storageKeyForRundown(pId), JSON.stringify(rd))
        setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
        setSelectedItemId(null)
      } else {
        alert('템플릿을 저장했습니다. 다음에 프로그램을 열면 자동으로 이 템플릿이 열립니다.')
      }
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

  function saveCurrentAsTemplate() {
    if (!rundown || !programId) return
    const t = rundownToTemplate(rundown)
    localStorage.setItem(storageKeyForTemplate(programId), JSON.stringify(t))
    alert('이 큐시트를 템플릿으로 저장했습니다. 다음에 프로그램을 열면 자동으로 이 템플릿이 열립니다.')
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
    const runnable: Array<Extract<RundownItem, { kind: 'newsItem' | 'sectionHeader' }>> = []
    let afterEnd = false
    for (const it of rundown.items) {
      if (it.kind === 'marker' && it.title === '뉴스끝') {
        afterEnd = true
      }
      if (afterEnd) continue
      if ((it.kind === 'newsItem' || it.kind === 'sectionHeader') && it.includeInRun) {
        runnable.push(it)
      }
    }
    let firstIdx = 0
    for (let i = 0; i < runnable.length; i += 1) {
      const dur = runnable[i]?.durationSeconds ?? 0
      if (dur > 0) {
        firstIdx = i
        break
      }
    }
    setPlay({
      state: 'running',
      currentIncludedIndex: Math.min(firstIdx, Math.max(0, runnable.length - 1)),
      itemStartedAtMs: now,
      pausedAtMs: null,
      pausedAccumulatedMs: 0,
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

  function nextItemNow() {
    const now = Date.now()
    // If we are currently playing (or paused), "commit" actual elapsed time to the current item duration.
    if (play.state !== 'idle' && includedRows.length > 0) {
      const idx = Math.min(play.currentIncludedIndex, includedRows.length - 1)
      const current = includedRows[idx]?.item
      if (current && (current.kind === 'newsItem' || current.kind === 'sectionHeader')) {
        const baseStartedAt = play.itemStartedAtMs ?? now
        const effectiveNow = play.state === 'paused' ? play.pausedAtMs ?? now : now
        const elapsedMs = Math.max(0, effectiveNow - baseStartedAt - play.pausedAccumulatedMs)
        const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
        const nextDuration = Math.max(0, elapsedSeconds)
        setRundownSafe((prev) => ({
          ...prev,
          items: prev.items.map((x) =>
            x.id === current.id && (x.kind === 'newsItem' || x.kind === 'sectionHeader') ? { ...x, durationSeconds: nextDuration } : x,
          ),
        }))
      }
    }

    setPlay((prev) => {
      if (includedRows.length === 0) return prev
      const next = Math.min(prev.currentIncludedIndex + 1, includedRows.length)
      if (next >= includedRows.length) {
        return { state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 }
      }
      return { ...prev, state: 'running', currentIncludedIndex: next, itemStartedAtMs: now, pausedAtMs: null, pausedAccumulatedMs: 0 }
    })
  }

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
                  <div className="programMeta">템플릿 자동 로딩(있으면) · 없으면 빈 큐시트</div>
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn subtle"
                onClick={() => void ensureAllTemplatesSavedToLocal()}
                title="GitHub에 커밋된 기본 템플릿 + 추가된 프로그램 템플릿을 로컬에 저장"
              >
                템플릿 전체 저장
              </button>
              <button className="btn subtle" onClick={() => void exportAllTemplates()} title="알려진 모든 템플릿을 한 파일로 내보내기">
                템플릿 전체 내보내기
              </button>
              <button className="btn subtle" onClick={() => void importAllTemplatesFromPublic()} title="저장된 기본 템플릿을 모두 불러오기(로컬에 덮어씀)">
                템플릿 전체 불러오기
              </button>
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
          </div>
        </div>
      </div>
    )
  }

  const delta = computed.deltaSeconds
  const currentPlayingId =
    play.state !== 'idle' && includedRows[play.currentIncludedIndex] ? includedRows[play.currentIncludedIndex]!.item.id : null

  return (
    <div className="appShell">
      <div className="topBar">
        <div className="brand">
          <div className="brandTitle">{rundown.programName}</div>
          <div className="brandSub">{rundown.broadcastDate}</div>
        </div>

        <div className="metrics">
          <div className="metric">
            <div className="label">뉴스 시작</div>
            <div className="value mono">{rundown.timing.newsStartTime}</div>
          </div>
          <div className="metric">
            <div className="label">편성시간</div>
            <div className="value mono">{formatSeconds(rundown.timing.scheduledSeconds)}</div>
          </div>
          <div className="metric">
            <div className="label">진행시간</div>
            <div className="value mono">{formatSeconds(elapsedRunSeconds)}</div>
          </div>
          <div className="metric">
            <div className="label">편성대비</div>
            <div className={delta < 0 ? 'value mono ok' : 'value mono bad'}>{formatDelta(delta)}</div>
          </div>
        </div>

        <div className="topActions">
          <span className="tag mono" title="뉴스끝 이전, includeInRun=true인 전체 아이템(뉴스+섹션) 합계">
            합계 {formatSeconds(computed.includedTotalSeconds)}
          </span>
          <button
            className="btn subtle"
            onClick={() => {
              setProgramId(null)
              setRundown(null)
              setSelectedItemId(null)
              setPlay({ state: 'idle', currentIncludedIndex: 0, itemStartedAtMs: null, pausedAtMs: null, pausedAccumulatedMs: 0 })
            }}
            title="프로그램 선택 화면으로 나가기"
          >
            뉴스나가기
          </button>
          <button className="btn" onClick={saveCurrentAsTemplate} title="현재 큐시트를 템플릿으로 저장">
            템플릿 저장
          </button>
          <button
            className="btn"
            onClick={() => {
              if (confirm('템플릿을 내보낼까요? (취소를 누르면 큐시트를 내보냅니다)')) exportTemplate()
              else exportRundown()
            }}
          >
            내보내기
          </button>
          <button
            className="btn"
            onClick={() => {
              if (!fileInputRef.current) return
              fileInputRef.current.value = ''
              fileInputRef.current.click()
            }}
          >
            불러오기
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
              <div>비고</div>
              <div className="right">조작</div>
            </div>

            {(() => {
              const rows = computed.rows
              const endIdx = rows.findIndex((r) => r.item.kind === 'marker' && r.item.title === '뉴스끝')
              const beforeEnd = endIdx >= 0 ? rows.slice(0, endIdx) : rows
              const endRow = endIdx >= 0 ? rows[endIdx] : null
              const afterEnd = endIdx >= 0 ? rows.slice(endIdx + 1) : []
              const afterEndSlots = afterEnd.slice(0, 2)

              let displayNo = 0
              const renderRow = (row: (typeof rows)[number]) => {
                const it = row.item
                const isMarkerEnd = it.kind === 'marker' && it.title === '뉴스끝'
                const isAfterEnd = row.isAfterEnd
                const start = row.startTime ?? null
                const duration = it.kind === 'newsItem' || it.kind === 'sectionHeader' ? it.durationSeconds : 0
                const isCurrent = currentPlayingId != null && it.id === currentPlayingId
                const emphasis = it.kind === 'newsItem' ? it.isEmphasis : false
                const selected = selectedItemId != null && it.id === selectedItemId

                const showNumber =
                  it.kind === 'newsItem' && (it.category === '완제' || it.category === '단신') && it.title.trim() !== ''
                if (showNumber) displayNo += 1

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
                    ].join(' ')}
                    onMouseDown={() => setSelectedItemId(it.id)}
                  >
                    <div className="mono">{showNumber ? String(displayNo).padStart(2, '0') : ''}</div>
                    <div>
                      {it.kind === 'newsItem' ? (
                        <select
                          className="select"
                          value={it.category}
                          onChange={(e) => {
                            const v = e.target.value
                            setRundownSafe((prev) => ({
                              ...prev,
                              items: prev.items.map((x) =>
                                x.id === it.id && x.kind === 'newsItem'
                                  ? { ...x, category: v, durationSeconds: defaultDurationForCategory(v) }
                                  : x,
                              ),
                            }))
                          }}
                        >
                          <option value="완제">완제</option>
                          <option value="단신">단신</option>
                          <option value=""></option>
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
                          {!it.includeInRun || isAfterEnd ? <span className="badge off">제외</span> : null}
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
                        <span className="muted">{it.kind === 'blank' ? '' : it.title}</span>
                      )}
                    </div>

                    <div className="right mono">{start ? start : ''}</div>
                    <div>
                      {it.kind === 'newsItem' ? (
                        <input
                          className="input"
                          value={it.notes}
                          onChange={(e) => {
                            const v = e.target.value
                            setRundownSafe((prev) => ({
                              ...prev,
                              items: prev.items.map((x) =>
                                x.id === it.id && x.kind === 'newsItem' ? { ...x, notes: v } : x,
                              ),
                            }))
                          }}
                        />
                      ) : (
                        ''
                      )}
                    </div>
                    <div className="right">
                      <div className="actions">
                        {it.kind === 'newsItem' ? (
                          <label className="emChk" title="글자 크게(+5pt)">
                            <input
                              type="checkbox"
                              checked={it.isEmphasis}
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
                        {it.kind === 'newsItem' || it.kind === 'sectionHeader' ? (
                          <DurationEditor
                            valueSeconds={duration}
                            onDelta={(d) => {
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
                            title={it.includeInRun && !isAfterEnd ? '진행 제외' : '진행 포함'}
                            onClick={() => {
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
                            title={it.includeInRun && !isAfterEnd ? '시간계산 제외' : '시간계산 포함'}
                            onClick={() => {
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
                            title="삭제"
                            onClick={() => {
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
                    style={{ paddingBottom: pinnedFooterHeight ? pinnedFooterHeight + 16 : undefined }}
                    onScroll={() => {
                      // follow toggle removed; keep behavior unchanged (no-op)
                    }}
                  >
                    {beforeEnd.map(renderRow)}
                    {endRow ? renderRow(endRow) : null}
                    {Array.from({ length: 2 }).map((_, i) => {
                      const row = afterEndSlots[i] ?? null
                      if (row) return renderRow(row)
                      return (
                        <div key={`pinned-spacer-${i}`} className="tr pinnedSpacerRow afterEnd">
                          <div className="mono"></div>
                          <div></div>
                          <div></div>
                          <div className="titleCell"></div>
                          <div className="right mono"></div>
                          <div></div>
                          <div className="right"></div>
                        </div>
                      )
                    })}
                    {afterEnd.length > 2 ? <div className="pinnedMore muted">… 뉴스끝 아래 {afterEnd.length - 2}개 더 있음</div> : null}

                    <div ref={pinnedFooterRef} className="footerBar pinnedFooter pinnedFooterFixed">
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <button
                          className="btn subtle"
                          disabled={!selectedItemId}
                          onClick={() => moveSelected(-1)}
                          title="선택한 아이템 위로"
                        >
                          위로
                        </button>
                        <button
                          className="btn subtle"
                          disabled={!selectedItemId}
                          onClick={() => moveSelected(1)}
                          title="선택한 아이템 아래로"
                        >
                          아래로
                        </button>
                        <button
                          className="btn subtle"
                          disabled={!selectedItemId || !!selectedRow?.isAfterEnd}
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
                          className="btn subtle"
                          onClick={() => {
                            const header: RundownItem = {
                              id: uid('s_'),
                              kind: 'sectionHeader',
                              title: '섹션',
                              durationSeconds: 0,
                              includeInRun: true,
                            }
                            setRundownSafe((prev) => ({ ...prev, items: insertBeforeMarkerEnd(prev.items, header) }))
                          }}
                        >
                          섹션 헤더
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
                        <button className="btn bigNextBtn" onClick={nextItemNow} disabled={play.state === 'idle'} title="다음 아이템으로">
                          다음 아이템
                        </button>
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
                            onBlur={() => {
                              const v = newsStartDraft
                              setRundownSafe((prev) => ({
                                ...prev,
                                timing: { ...prev.timing, newsStartTime: v },
                              }))
                            }}
                          />
                        </label>
                        <label className="field">
                          <span className="fieldLabel">편성(mm:ss)</span>
                          <input
                            className="input mono"
                            value={scheduledDraft}
                            onChange={(e) => {
                              setScheduledDraft(e.target.value)
                            }}
                            onFocus={(e) => {
                              e.currentTarget.select()
                            }}
                            onBlur={() => {
                              const secs = parseTimeToSeconds(scheduledDraft)
                              if (secs == null) {
                                setScheduledDraft(formatSeconds(rundown.timing.scheduledSeconds))
                                return
                              }
                              setRundownSafe((prev) => ({
                                ...prev,
                                timing: { ...prev.timing, scheduledSeconds: secs },
                              }))
                            }}
                          />
                        </label>
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
  onDelta: (deltaSeconds: number) => void
}) {
  return (
    <div className="dur">
      <div className="durBtns">
        <button className="miniBtn" onClick={() => props.onDelta(-5)}>
          -5
        </button>
        <button className="miniBtn" onClick={() => props.onDelta(1)} title="+1초">
          +1
        </button>
        <button className="miniBtn" onClick={() => props.onDelta(5)}>
          +5
        </button>
        <button className="miniBtn" onClick={() => props.onDelta(10)}>
          +10
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
