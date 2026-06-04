import type { ArticleScript } from './types'

/** 공백 제외 글자 수 (한글·영문 등) */
export function countReadableChars(text: string): number {
  return text.replace(/\s/g, '').length
}

export type MeasureOptions = {
  charsPerSecond: number
  minSeconds?: number
  roundTo?: number
}

export function measureTextSeconds(text: string, opts: MeasureOptions): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const chars = countReadableChars(trimmed)
  if (chars === 0) return 0
  const raw = chars / opts.charsPerSecond
  const min = opts.minSeconds ?? 0
  let sec = Math.max(min, Math.ceil(raw))
  const roundTo = opts.roundTo
  if (roundTo && roundTo > 1) {
    sec = Math.ceil(sec / roundTo) * roundTo
  }
  return sec
}

const ANCHOR_CPS = 4.0
const BODY_CPS = 4.2

export function measureAnchorSeconds(text: string): number {
  return measureTextSeconds(text, { charsPerSecond: ANCHOR_CPS, minSeconds: 3, roundTo: 5 })
}

export function measureBodySeconds(text: string): number {
  return measureTextSeconds(text, { charsPerSecond: BODY_CPS, minSeconds: 5, roundTo: 5 })
}

export function measureArticleScript(script: ArticleScript): {
  anchorSeconds: number
  bodySeconds: number
  currentSeconds: number
} {
  const anchorSeconds = script.anchorIncluded ? measureAnchorSeconds(script.anchorText) : 0
  const bodySeconds = script.bodyIncluded ? measureBodySeconds(script.bodyText) : 0
  return {
    anchorSeconds,
    bodySeconds,
    currentSeconds: anchorSeconds + bodySeconds,
  }
}

export function createArticleScript(anchorText = '', bodyText = ''): ArticleScript {
  return {
    anchorText,
    bodyText,
    anchorIncluded: true,
    bodyIncluded: true,
    baselineSeconds: 0,
    preferredDurationSeconds: null,
  }
}

/** 앵커+기사를 단락 없이 한 덩어리로 측정할 때 */
export function measureCombinedScriptSeconds(script: ArticleScript): number {
  const parts: string[] = []
  if (script.anchorIncluded && script.anchorText.trim()) parts.push(script.anchorText.trim())
  if (script.bodyIncluded && script.bodyText.trim()) parts.push(script.bodyText.trim())
  return measureBodySeconds(parts.join(''))
}

export function resolveArticleDurationSeconds(script: ArticleScript): number {
  if (typeof script.preferredDurationSeconds === 'number' && script.preferredDurationSeconds >= 0) {
    return script.preferredDurationSeconds
  }
  return measureArticleScript(script).currentSeconds
}
