// Subscription quota seen in provider responses, and spend read from session files. No Pi
// imports, so node --test runs it.

export type Window = { name: string; used: number; resetsAt?: number } // used: 0..1; resetsAt: ms
export type Quota = { windows: Window[]; status?: string; raw: Record<string, string> }
export type Seen = Quota & { at: number }
export type State = Record<string, Seen> // by provider
export type Usage = { tokens: number; cost: number }

// Headers worth keeping whatever their format, so a provider's real one can be read off /usage.
const RATE = /ratelimit|rate-limit|quota|x-codex-/i

const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined)
const seconds = (v: unknown) => (num(v) === undefined ? undefined : (num(v) as number) * 1000)
const span = (minutes: number | undefined, fallback: string) =>
  !minutes ? fallback : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`

// Claude (the bridge rebuilds Claude Code's plan usage as these headers): utilization 0..1, reset in
// Unix seconds. Codex: used percent 0..100, window in minutes, reset in Unix seconds.
export function fromHeaders(headers: Record<string, string>): Quota | undefined {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const windows: Window[] = []
  const claude = "anthropic-ratelimit-unified-"
  for (const key of Object.keys(h)) {
    const m = new RegExp(`^${claude}(\\w+)-utilization$`).exec(key)
    const used = m ? num(h[key]) : undefined
    if (m && used !== undefined) windows.push({ name: m[1], used, resetsAt: seconds(h[`${claude}${m[1]}-reset`]) })
  }
  for (const w of ["primary", "secondary"]) {
    const used = num(h[`x-codex-${w}-used-percent`])
    if (used !== undefined)
      windows.push({ name: span(num(h[`x-codex-${w}-window-minutes`]), w), used: used / 100, resetsAt: seconds(h[`x-codex-${w}-reset-at`]) })
  }
  const raw = Object.fromEntries(Object.entries(h).filter(([k]) => RATE.test(k) && !k.startsWith(claude) && !/^x-codex-(primary|secondary)-/.test(k)))
  if (!windows.length && !Object.keys(raw).length) return undefined
  const status = h[`${claude}status`]
  return status ? { windows, status, raw } : { windows, raw }
}

// Codex's codex.rate_limits stream event: the same windows as its headers.
export function fromEvent(data: unknown): Quota | undefined {
  const e = data as { type?: unknown; rate_limits?: Record<string, { used_percent?: unknown; window_minutes?: unknown; reset_at?: unknown }> }
  if (e?.type !== "codex.rate_limits" || !e.rate_limits) return undefined
  const windows: Window[] = []
  for (const [w, v] of Object.entries(e.rate_limits)) {
    const used = num(v?.used_percent)
    if (used !== undefined) windows.push({ name: span(num(v.window_minutes), w), used: used / 100, resetsAt: seconds(v.reset_at) })
  }
  return windows.length ? { windows, raw: {} } : undefined
}

export function parseState(text: string | undefined): State {
  try {
    const s = JSON.parse(text ?? "")
    return s && typeof s === "object" && !Array.isArray(s) ? s : {}
  } catch {
    return {}
  }
}

export const merge = (s: State, provider: string, q: Quota, now: number): State => ({ ...s, [provider]: { ...q, at: now } })

export function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : `${Math.floor(m / 1440)}d`
}

const pct = (w: Window) => `${w.name} ${Math.round(w.used * 100)}%`

export const windowsLine = (q: Seen, now: number) =>
  q.windows.map((w) => (w.resetsAt && w.resetsAt > now ? `${pct(w)} (${ago(w.resetsAt - now)})` : pct(w))).join(" · ")

// The bottom bar: the windows only; nothing for a provider that reports none.
export const statusLine = (provider: string, q: Seen | undefined) =>
  q?.windows.length ? `${provider} ${q.windows.map(pct).join(" · ")}` : undefined

const DAY = 86_400_000
const add = (u: Usage, tokens: number, cost: number) => ((u.tokens += tokens), (u.cost += cost))
const bump = (m: Map<string, Usage>, k: string, tokens: number, cost: number) => {
  if (!m.has(k)) m.set(k, { tokens: 0, cost: 0 })
  add(m.get(k)!, tokens, cost)
}

export type Spend = { today: Usage; week: Usage; month: Usage; byModel: Map<string, Usage>; bySource: Map<string, Usage> }

// Session files (JSONL): each assistant message's usage, and the budget-usage entries the budget
// extension stores for task children, scouts and /btw, which keep no session of their own.
// "today" is the last 24 hours; byModel and bySource cover the last 30 days.
export function spend(files: string[], now: number): Spend {
  const s: Spend = { today: { tokens: 0, cost: 0 }, week: { tokens: 0, cost: 0 }, month: { tokens: 0, cost: 0 }, byModel: new Map(), bySource: new Map() }
  for (const text of files) {
    for (const line of text.split("\n")) {
      let e: any
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const age = now - Date.parse(e?.timestamp)
      if (!(age >= 0 && age < 30 * DAY)) continue
      let tokens: number, cost: number
      if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
        const u = e.message.usage
        tokens = (u.input ?? 0) + (u.output ?? 0)
        cost = u.cost?.total ?? 0
        bump(s.byModel, `${e.message.provider}/${e.message.model}`, tokens, cost)
      } else if (e.type === "custom" && e.customType === "budget-usage" && e.data) {
        tokens = e.data.tokens ?? 0
        cost = e.data.cost ?? 0
        bump(s.bySource, e.data.source ?? "other", tokens, cost)
      } else continue
      add(s.month, tokens, cost)
      if (age < 7 * DAY) add(s.week, tokens, cost)
      if (age < DAY) add(s.today, tokens, cost)
    }
  }
  return s
}
