import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerSrc

/** PDF 각 페이지에서 추출한 비어 있지 않은 텍스트 토큰 */
export async function extractPdfPageTokens(file: File): Promise<string[][]> {
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await getDocument({ data, useSystemFonts: true }).promise
  const pages: string[][] = []

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    const tokens = content.items
      .map((item) => ('str' in item ? String(item.str) : ''))
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    pages.push(tokens)
  }

  return pages
}

/** 페이지 헤더를 제외하고 본문 토큰만 이어 붙임 */
export function mergeCueTokens(pages: string[][]): string[] {
  const merged: string[] = []
  let sawHeader = false

  for (const pageTokens of pages) {
    const headerIdx = pageTokens.findIndex((t) => t === '부가자막')
    const start = headerIdx >= 0 ? headerIdx + 1 : 0
    if (sawHeader && headerIdx >= 0) {
      merged.push(...pageTokens.slice(start))
      continue
    }
    if (headerIdx >= 0) sawHeader = true
    merged.push(...pageTokens.slice(start))
  }

  return merged
}
