/** 큐시트 구분 — PDF·UI·저장 공통 */
export const CUE_CATEGORIES = ['완제', '단신', '타이틀', 'CM', '공란'] as const
export type CueCategory = (typeof CUE_CATEGORIES)[number]

export const CATEGORY_BLANK = '공란'

/** 앵커 교체 등 구분 없는 행 — 오프닝과 동일 10초 */
export const ANCHOR_BLANK_DURATION = 10

export const DEFAULT_DURATION_BY_CATEGORY: Record<string, number> = {
  완제: 90,
  단신: 30,
  타이틀: 10,
  CM: 60,
  공란: 0,
  오프닝: 0,
  클로징: 0,
  '': 0,
}

export function isAnchorBlankSlot(notes: string, reporter: string, title = ''): boolean {
  if (title.trim()) return false
  if (notes.trim() === '앵커') return true
  if (/앵커/.test(notes)) return true
  return /^[가-힣]{2,5}$/.test(reporter.trim())
}

export function defaultDurationForBlankSlot(opts: {
  notes?: string
  reporter?: string
  title?: string
}): number {
  return isAnchorBlankSlot(opts.notes ?? '', opts.reporter ?? '', opts.title ?? '')
    ? ANCHOR_BLANK_DURATION
    : 0
}

export function defaultDurationForCategory(category: string): number {
  if (category === CATEGORY_BLANK) return 0
  return DEFAULT_DURATION_BY_CATEGORY[category] ?? 90
}

export function isArticleCategory(category: string): boolean {
  return category === '완제' || category === '단신'
}

export function isStructuralCategory(category: string): boolean {
  return (
    category === CATEGORY_BLANK ||
    category === '타이틀' ||
    category === 'CM' ||
    category === '오프닝' ||
    category === '클로징'
  )
}

export function isBlankSlotCategory(category: string): boolean {
  return category === CATEGORY_BLANK || category === '오프닝' || category === '클로징' || category === ''
}

/** 예전 PDF/저장·레거시 구분을 공란/타이틀 등으로 복원 */
export function normalizeNewsCategory(category: string, title: string): string {
  const t = title.trim()
  if (t === '타이틀' || /메인타이틀|DDR타이틀|타이틀\s*\(?DDR|\[DDR\]/i.test(t)) return '타이틀'
  if (/^전\s*CM|^전CM|\d부\s*전CM|^CM\s*\(|^중간광고/i.test(t)) return 'CM'
  if (/^오프닝/i.test(t) || /앵커\s*$/.test(t) || /클로징|뉴스25\s*끝/i.test(t)) return CATEGORY_BLANK
  if (/^단\/|^날씨(?:$|\s|\()|\[질문\s*\d|^주요뉴스\s*\d|^\(\+시보\)/i.test(t)) return '단신'
  if (category === '오프닝' || category === '클로징') return CATEGORY_BLANK
  if (category && category !== CATEGORY_BLANK) return category
  if (!t && (category === '' || category === CATEGORY_BLANK)) return CATEGORY_BLANK
  return category || '완제'
}

/** 구분 셀렉트·버튼에 표시할 라벨 (공란은 글자 없음) */
export function categoryLabelForUi(category: string): string {
  if (category === CATEGORY_BLANK) return ''
  return category
}

export function orderLabelForCategory(category: string): string {
  switch (category) {
    case '타이틀':
      return 'T'
    case 'CM':
      return 'CM'
    case '단신':
      return '단'
    case CATEGORY_BLANK:
    case '오프닝':
    case '클로징':
      return ''
    default:
      return ''
  }
}
