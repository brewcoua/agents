export type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number }
// Per million tokens, by the model's name without its cloud suffix (prices.json).
export type Prices = Record<string, { input?: number; cacheRead?: number; output?: number }>

export type Show = { contextWindow?: number; vision: boolean; thinking: boolean }

export type ModelEntry = {
  id: string
  name: string
  reasoning: boolean
  input: ("text" | "image")[]
  cost: Cost
  contextWindow: number
  maxTokens: number
}

const DEFAULT_CONTEXT = 128000
// ollama reports no output limit; Pi's default of 16K is too low for coding.
const MAX_OUTPUT = 65536

// OpenAI-compatible /models: { data: [{ id }] }.
export function parseModelIds(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id !== "")
}

// ollama /api/show: capabilities ["completion","tools","vision","thinking"] and
// model_info["<arch>.context_length"].
export function parseShow(json: unknown): Show {
  const j = json as { capabilities?: unknown; model_info?: Record<string, unknown> }
  const caps = Array.isArray(j?.capabilities) ? j.capabilities : []
  const key = Object.keys(j?.model_info ?? {}).find((k) => k.endsWith(".context_length"))
  const n = key ? j.model_info![key] : undefined
  return {
    contextWindow: typeof n === "number" && n > 0 ? n : undefined,
    vision: caps.includes("vision"),
    thinking: caps.includes("thinking"),
  }
}

// A cloud tag is "<name>:cloud" or "<name>-cloud" (gpt-oss:120b-cloud); a local model costs nothing.
export function priceFor(id: string, prices: Prices): Cost {
  const m = /^(.+)[:-]cloud$/.exec(id)
  const p = (m && prices[m[1]]) || {}
  return { input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? 0, cacheWrite: 0 }
}

export function buildEntry(id: string, show?: Show, prices: Prices = {}): ModelEntry {
  const contextWindow = show?.contextWindow ?? DEFAULT_CONTEXT
  return {
    id,
    name: id,
    reasoning: show?.thinking ?? false,
    input: show?.vision ? ["text", "image"] : ["text"],
    cost: priceFor(id, prices),
    contextWindow,
    maxTokens: Math.min(MAX_OUTPUT, contextWindow),
  }
}

// Only a literal or $NAME / ${NAME} key is sent; a "!command" is never run here.
export function bearer(apiKey: unknown, env: Record<string, string | undefined>): string | undefined {
  if (typeof apiKey !== "string" || apiKey === "" || apiKey.startsWith("!")) return undefined
  const m = apiKey.match(/^\$\{?(\w+)\}?$/)
  return m ? env[m[1]] || undefined : apiKey
}

// /v1 base URL -> ollama's native endpoint on the same host.
export function showUrl(baseUrl: string): string {
  return new URL("/api/show", baseUrl).href
}
