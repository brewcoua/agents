export interface Limits {
  usd: number
  tokens: number
}

export type Usage = { cost: number; tokens: number }

// Emitted on pi.events by the agents and btw extensions with { source, cost, tokens }: usage of
// other sessions this one started.
export const USAGE_EVENT = "othala:usage"

export interface Totals {
  cost: number // this session's own messages, plus `others`
  tokens: number
  // Latest figure per message: a message can be reported more than once.
  seen: Map<string, Usage>
  // What this session started in other sessions: task children, scouts, /btw. By source.
  others: Map<string, Usage>
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
  return { cost: 0, tokens: 0, seen: new Map(), others: new Map(), warnedAt: 0, stopped: false }
}

function sum(t: Totals) {
  t.cost = 0
  t.tokens = 0
  for (const e of [...t.seen.values(), ...t.others.values()]) {
    t.cost += e.cost
    t.tokens += e.tokens
  }
}

export function record(t: Totals, id: string, cost: number, tokens: number) {
  t.seen.set(id, { cost, tokens })
  sum(t)
}

export function addOther(t: Totals, source: string, u: Usage) {
  const was = t.others.get(source) ?? { cost: 0, tokens: 0 }
  t.others.set(source, { cost: was.cost + u.cost, tokens: was.tokens + u.tokens })
  sum(t)
}

export const own = (t: Totals): Usage => {
  const o = { cost: 0, tokens: 0 }
  for (const e of t.seen.values()) (o.cost += e.cost), (o.tokens += e.tokens)
  return o
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

export const usd = (n: number) => `$${n.toFixed(2)}`
export const count = (n: number) => n.toLocaleString("en-US")
export const short = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

// The status line: the share of the nearest cap, then what is counted against each.
export function status(t: Totals, l: Limits): string {
  const parts = [`budget ${Math.floor(fraction(t, l) * 100)}%`]
  if (l.tokens > 0) parts.push(`${short(t.tokens)}/${short(l.tokens)} tok`)
  if (l.usd > 0 && t.cost > 0) parts.push(`${usd(t.cost)}/${usd(l.usd)}`)
  return parts.join(" · ")
}

export function summary(t: Totals, l: Limits): string {
  const parts = []
  if (l.usd > 0) parts.push(`${usd(t.cost)} of ${usd(l.usd)}`)
  if (l.tokens > 0) parts.push(`${count(t.tokens)} of ${count(l.tokens)} tokens`)
  return parts.join(", ")
}
