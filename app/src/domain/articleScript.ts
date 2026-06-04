import type { ArticleScript } from './types'

export function getCombinedManuscript(script: ArticleScript): string {
  const a = script.anchorText.trim()
  const b = script.bodyText.trim()
  if (a && b) return `${a}\n\n${b}`
  return a || b
}

/** 단락 없이 한 칸에 넣을 때: 전체를 기사로 두고 앵커는 비움 */
export function scriptFromCombinedManuscript(text: string, prev?: ArticleScript): ArticleScript {
  return {
    ...(prev ?? {
      anchorIncluded: false,
      bodyIncluded: true,
      baselineSeconds: 0,
      preferredDurationSeconds: null,
    }),
    anchorText: '',
    bodyText: text,
    anchorIncluded: false,
    bodyIncluded: true,
  }
}

/** `---` 한 줄 또는 빈 줄 2개로 앵커/기사 분리 시도 */
export function splitManuscript(text: string): { anchorText: string; bodyText: string } {
  const delim = text.match(/\n\s*---\s*\n/)
  if (delim) {
    const idx = text.indexOf(delim[0])
    return {
      anchorText: text.slice(0, idx).trim(),
      bodyText: text.slice(idx + delim[0].length).trim(),
    }
  }
  const paragraphs = text.split(/\n\n+/)
  if (paragraphs.length >= 2) {
    return {
      anchorText: paragraphs[0]!.trim(),
      bodyText: paragraphs.slice(1).join('\n\n').trim(),
    }
  }
  return { anchorText: '', bodyText: text.trim() }
}

export function scriptFromSplit(anchorText: string, bodyText: string, prev?: ArticleScript): ArticleScript {
  return {
    ...(prev ?? {
      baselineSeconds: 0,
      preferredDurationSeconds: null,
    }),
    anchorText,
    bodyText,
    anchorIncluded: anchorText.trim().length > 0,
    bodyIncluded: bodyText.trim().length > 0,
  }
}
