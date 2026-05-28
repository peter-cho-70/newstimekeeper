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
      includeInRun: boolean
      flags: string[]
    }
  | { id: string; kind: 'blank'; title: string; includeInRun: false }
  | { id: string; kind: 'sectionHeader'; title: string; durationSeconds: number; includeInRun: false }
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
      includeInRun: boolean
      flags: string[]
    }
  | { id: string; kind: 'blank'; title: string; includeInRun: false }
  | { id: string; kind: 'sectionHeader'; title: string; durationSeconds: number; includeInRun: false }
  | { id: string; kind: 'marker'; title: string; includeInRun: false }

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
    toleranceSeconds: number
  }
  items: RundownItem[]
}

