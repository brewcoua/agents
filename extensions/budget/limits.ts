export interface Limits {
  usd: number
  tokens: number
}

export interface Totals {
  cost: number
  tokens: number
  // Latest figure per message: a message can be reported more than once.
  seen: Map<string, { cost: number; tokens: number }>
  warnedAt: number
  stopped: boolean
}

export const LEVELS = [0.25, 0.5, 0.75]

// An unset or unparsable variable gives the fallback. A value of 0 or less disables that cap.
export function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export function fresh(): Totals {
  return { cost: 0, tokens: 0, seen: new Map(), warnedAt: 0, stopped: false }
}

export function record(t: Totals, id: string, cost: number, tokens: number) {
  t.seen.set(id, { cost, tokens })
  t.cost = 0
  t.tokens = 0
  for (const e of t.seen.values()) {
    t.cost += e.cost
    t.tokens += e.tokens
  }
}

// Share of the nearest enabled cap that is used up; 0 when every cap is disabled.
export function fraction(t: Totals, l: Limits): number {
  return Math.max(l.usd > 0 ? t.cost / l.usd : 0, l.tokens > 0 ? t.tokens / l.tokens : 0)
}

// The highest soft level newly crossed, or the hard stop. Each fires once per session.
export function check(t: Totals, l: Limits): { kind: "stop" | "warn"; level: number } | undefined {
  const f = fraction(t, l)
  if (f >= 1) {
    if (t.stopped) return undefined
    t.stopped = true
    return { kind: "stop", level: 1 }
  }
  const level = LEVELS.filter((k) => f >= k).pop()
  if (level === undefined || level <= t.warnedAt) return undefined
  t.warnedAt = level
  return { kind: "warn", level }
}

const usd = (n: number) => `$${n.toFixed(2)}`
const count = (n: number) => n.toLocaleString("en-US")

export function summary(t: Totals, l: Limits): string {
  const parts = []
  if (l.usd > 0) parts.push(`${usd(t.cost)} of ${usd(l.usd)}`)
  if (l.tokens > 0) parts.push(`${count(t.tokens)} of ${count(l.tokens)} tokens`)
  return parts.join(", ")
}
