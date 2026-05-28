export function uid(prefix: string): string {
  // Good enough for local-only MVP IDs
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(2)}`
}

