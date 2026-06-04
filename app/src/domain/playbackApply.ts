import type { Rundown } from './types'

export type PlayElapsedSnapshot = {
  state: 'idle' | 'running' | 'paused'
  elapsedByItemIdMs: Record<string, number>
  currentIncludedIndex: number
  itemStartedAtMs: number | null
  pausedAtMs: number | null
  pausedAccumulatedMs: number
}

function currentItemElapsedMs(now: number, play: PlayElapsedSnapshot): number {
  if (play.state === 'idle' || play.itemStartedAtMs == null) return 0
  const effectiveNow = play.state === 'paused' ? play.pausedAtMs ?? now : now
  return Math.max(0, effectiveNow - play.itemStartedAtMs - play.pausedAccumulatedMs)
}

/**
 * 진행 세션에 기록된 실제 경과 시간을 큐시트 durationSeconds에 반영.
 */
export function applyActualDurationsFromPlay(
  rundown: Rundown,
  play: PlayElapsedSnapshot,
  includedItemIds: string[],
): Rundown {
  const elapsedMs = { ...play.elapsedByItemIdMs }

  if (play.state !== 'idle' && includedItemIds.length > 0) {
    const idx = Math.min(play.currentIncludedIndex, Math.max(0, includedItemIds.length - 1))
    const curId = includedItemIds[idx]
    if (curId) elapsedMs[curId] = currentItemElapsedMs(Date.now(), play)
  }

  const hasAnyElapsed = Object.keys(elapsedMs).length > 0
  if (!hasAnyElapsed) return rundown

  return {
    ...rundown,
    updatedAt: new Date().toISOString(),
    items: rundown.items.map((it) => {
      if (it.kind !== 'newsItem' && it.kind !== 'sectionHeader') return it
      const ms = elapsedMs[it.id]
      if (ms == null) return it
      const sec = Math.max(0, Math.round(ms / 1000))
      return { ...it, durationSeconds: sec }
    }),
  }
}

export function hasPlaybackDurationData(play: PlayElapsedSnapshot): boolean {
  if (Object.keys(play.elapsedByItemIdMs).length > 0) return true
  return play.state !== 'idle'
}
