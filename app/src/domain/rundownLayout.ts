import type { RundownItem } from './types'
import { CATEGORY_BLANK, isArticleCategory, isStructuralCategory } from './cueCategories'
import { uid } from './uid'

export function createBlankItem(): RundownItem {
  return { id: uid('b_'), kind: 'blank', title: '', includeInRun: false }
}

function lastItem(out: RundownItem[]): RundownItem | undefined {
  return out[out.length - 1]
}

function pushBlankIfNeeded(out: RundownItem[]) {
  const prev = lastItem(out)
  if (prev && prev.kind !== 'blank') out.push(createBlankItem())
}

function isMainNewsItem(it: RundownItem): boolean {
  return it.kind === 'newsItem' && isArticleCategory(it.category)
}

function isStructuralItem(it: RundownItem): boolean {
  return (
    it.kind === 'newsItem' &&
    (isStructuralCategory(it.category) || it.category === '' || it.category === CATEGORY_BLANK)
  )
}

/**
 * 큐시트 가독성용 빈줄 삽입 (시간 계산 제외, 기존 「빈줄」과 동일).
 * - 오프닝·CM 등 구조 블록 다음 → 본편 기사 앞
 * - 섹션 헤더 앞
 * - 뉴스끝 마커 앞 / 뒤(예비 아이템 구간)
 */
export function insertVisualBlankSeparators(items: RundownItem[]): RundownItem[] {
  const out: RundownItem[] = []
  let seenMainNews = false

  for (const it of items) {
    if (it.kind === 'marker' && it.title === '뉴스끝') {
      pushBlankIfNeeded(out)
      out.push(it)
      continue
    }

    if (it.kind === 'sectionHeader') {
      pushBlankIfNeeded(out)
      out.push(it)
      continue
    }

    if (isMainNewsItem(it) && !seenMainNews) {
      seenMainNews = true
      const prev = lastItem(out)
      if (prev && (isStructuralItem(prev) || prev.kind === 'sectionHeader')) {
        pushBlankIfNeeded(out)
      }
    }

    out.push(it)
  }

  const endIdx = out.findIndex((x) => x.kind === 'marker' && x.title === '뉴스끝')
  if (endIdx >= 0 && endIdx < out.length - 1 && out[endIdx + 1]?.kind !== 'blank') {
    out.splice(endIdx + 1, 0, createBlankItem())
  }

  return out
}
