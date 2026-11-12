// Tier file of the tasks extension: no Pi imports, so node --test runs it.

export type Model = { provider: string; id: string }
export const TIER_NAMES = ["plan", "large", "small"] as const
export type Tier = (typeof TIER_NAMES)[number]
export type Tiers = Record<Tier, Model> & { maxConcurrent: number }

// "claude-bridge/claude-opus-5-5": the provider is everything before the first slash.
export function splitModel(text: string): Model {
  const i = text.indexOf("/")
  if (i < 1 || i === text.length - 1) throw new Error(`"${text}" is not a provider/model pair`)
  return { provider: text.slice(0, i), id: text.slice(i + 1) }
}

export function parseTiers(text: string): Tiers {
  const raw = JSON.parse(text) as Record<string, unknown>
  const out: Partial<Tiers> = {}
  for (const tier of TIER_NAMES) {
    if (typeof raw[tier] !== "string") throw new Error(`tasks.json: "${tier}" must be a "provider/model" string`)
    out[tier] = splitModel(raw[tier])
  }
  const n = raw.maxConcurrent
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error('tasks.json: "maxConcurrent" must be a positive integer')
  out.maxConcurrent = n
  return out as Tiers
}
