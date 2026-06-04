export type ArticleScript = {
  anchorText: string
  bodyText: string
  anchorIncluded: boolean
  bodyIncluded: boolean
  /** 최초 측정 합계(초). 편집 후 절감량 비교용 */
  baselineSeconds: number
  /** 사용자가 지정한 큐시트 반영 길이(초). 없으면 자동 측정값 사용 */
  preferredDurationSeconds?: number | null
}

export type TemplateItem =
  | {
      id: string
      kind: 'newsItem'
      category: string
      reporter: string
      title: string
      durationSeconds: number
      notes: string
      isDefaultItem: boolean
      isEmphasis: boolean
      isTimeAdjust: boolean
      includeInRun: boolean
      flags: string[]
      article?: ArticleScript
    }
  | { id: string; kind: 'blank'; title: string; includeInRun: false }
  | { id: string; kind: 'sectionHeader'; title: string; durationSeconds: number; includeInRun: boolean }
  | { id: string; kind: 'marker'; title: string; includeInRun: false }

export type Template = {
  schemaVersion: string
  type: 'template'
  programId: string
  programName: string
  createdAt: string
  updatedAt: string
  defaults: {
    scheduledSeconds: number
    newsStartTime: string
  }
  items: TemplateItem[]
}

export type RundownItem =
  | {
      id: string
      kind: 'newsItem'
      category: string
      reporter: string
      title: string
      durationSeconds: number
      notes: string
      isDefaultItem: boolean
      isEmphasis: boolean
      isTimeAdjust: boolean
      includeInRun: boolean
      flags: string[]
      article?: ArticleScript
    }
  | { id: string; kind: 'blank'; title: string; includeInRun: false }
  | { id: string; kind: 'sectionHeader'; title: string; durationSeconds: number; includeInRun: boolean }
  | { id: string; kind: 'marker'; title: string; includeInRun: false }

export type BudgetMode = 'scheduled' | 'endClock'

export type Rundown = {
  schemaVersion: string
  type: 'rundown'
  programId: string
  programName: string
  broadcastDate: string
  episodeLabel: string
  createdAt: string
  updatedAt: string
  timing: {
    newsStartTime: string
    scheduledSeconds: number
    /** HH:MM:SS — used when budgetMode is endClock */
    newsEndTime: string
    budgetMode: BudgetMode
    /** When true (default), start playback automatically at newsStartTime. */
    autoStartAtNewsTime: boolean
    toleranceSeconds: number
  }
  items: RundownItem[]
}

