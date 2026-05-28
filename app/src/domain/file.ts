export async function readJsonFile<T>(file: File): Promise<T> {
  const text = await file.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('JSON 파싱에 실패했습니다.')
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

