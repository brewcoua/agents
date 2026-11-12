import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type Show, bearer, buildEntry, parseModelIds, parseShow, showUrl } from "./discovery.ts"

const TIMEOUT_MS = 3000

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")

function debug(msg: string) {
  if (process.env.OTHALA_DEBUG) console.error(`[models-discovery] ${msg}`)
}

async function get(url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return res.json()
}

export default async function (pi: ExtensionAPI) {
  let providers: Record<string, any>
  try {
    providers = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers ?? {}
  } catch {
    return
  }

  await Promise.all(
    // A provider opts in with "modelsDiscovery": true in models.json (Pi's schema leaves provider objects open).
    Object.entries(providers).map(async ([name, p]) => {
      if (p?.modelsDiscovery !== true || !p.baseUrl) return
      const key = bearer(p.apiKey, process.env)
      const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}
      try {
        const base = p.baseUrl.replace(/\/$/, "")
        const ids = parseModelIds(await get(`${base}/models`, headers))
        // A registration replaces the provider's models.json models, so those are carried
        // over, and they win over discovery for an id both list.
        const own: { id: string }[] = p.models ?? []
        const found = await Promise.all(
          ids.filter((id) => !own.some((m) => m.id === id)).map(async (id) => {
            let show: Show | undefined
            try {
              show = parseShow(await get(showUrl(base), headers, { model: id }))
            } catch {
              // not ollama, or the model vanished: defaults
            }
            return buildEntry(id, show)
          }),
        )
        const models = [...own.map((m) => ({ ...buildEntry(m.id), ...m })), ...found]
        if (found.length === 0) return
        pi.registerProvider(name, { baseUrl: p.baseUrl, apiKey: p.apiKey, api: p.api ?? "openai-completions", models })
      } catch (err) {
        debug(`${name}: ${(err as Error).message}`)
      }
    }),
  )
}
