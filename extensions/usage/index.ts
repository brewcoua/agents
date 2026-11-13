import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { count, usd } from "../budget/limits.ts"
import { type Row, showList } from "../lib/view.ts"
import { type Quota, type Usage, ago, fromEvent, fromHeaders, merge, parseState, spend, statusLine, windowsLine } from "./usage.ts"

// Shared by every pi on the machine, task children included: the last quota each provider reported.
const stateFile = () => join(getAgentDir(), "othala-usage.json")
const DAY = 86_400_000

function readState() {
  try {
    return parseState(readFileSync(stateFile(), "utf8"))
  } catch {
    return {}
  }
}

// Session files changed in the last 30 days, under every project's session directory.
function sessionFiles(dir: string, now: number): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const path = join(dir, name)
    const st = statSync(path, { throwIfNoEntry: false })
    if (st?.isDirectory()) out.push(...sessionFiles(path, now))
    else if (st && name.endsWith(".jsonl") && now - st.mtimeMs < 30 * DAY) out.push(readFileSync(path, "utf8"))
  }
  return out
}

const seen = (ms: number) => (ago(ms) === "now" ? "just now" : `${ago(ms)} ago`)
const line = (label: string, u: Usage) => `${label.padEnd(34)} ${count(u.tokens).padStart(13)} tok  ${usd(u.cost)}`

export default function (pi: ExtensionAPI) {
  const show = (ctx: ExtensionContext) => {
    const provider = ctx.model?.provider
    ctx.ui.setStatus("usage", provider ? statusLine(provider, readState()[provider]) : undefined)
  }

  // A run keeps going while this records: a failed write only loses one reading.
  function record(provider: string | undefined, q: Quota | undefined, ctx: ExtensionContext) {
    if (!provider || !q) return
    try {
      writeFileSync(stateFile(), `${JSON.stringify(merge(readState(), provider, q, Date.now()), null, 2)}\n`)
    } catch {
      return
    }
    show(ctx)
  }

  pi.on("session_start", (_e, ctx) => show(ctx))
  pi.on("model_select", (_e, ctx) => show(ctx))
  pi.on("after_provider_response", (event, ctx) => record(ctx.model?.provider, fromHeaders(event.headers), ctx))
  pi.on("provider_stream_event", (event, ctx) => record(event.provider, fromEvent(event.data), ctx))

  pi.registerCommand("usage", {
    description: "Subscription quota each provider last reported, and spend over the last day, week and month",
    handler: async (_args, ctx) => {
      await showList(ctx, {
        title: "usage",
        empty: "No quota reported and no session in the last 30 days.",
        refreshMs: 5000,
        rows: () => {
          const now = Date.now()
          const rows: Row[] = []
          for (const [provider, q] of Object.entries(readState()).sort(([, a], [, b]) => b.at - a.at)) {
            const summary = windowsLine(q, now) || q.status || Object.entries(q.raw).map(([k, v]) => `${k}=${v}`).join(" ")
            rows.push({
              label: `${provider.padEnd(16)} ${summary}  (${seen(now - q.at)})`,
              dim: now - q.at > DAY,
              detail: () =>
                [
                  `${provider}, reported ${new Date(q.at).toLocaleString()}`,
                  ...(q.status ? [`status ${q.status}`] : []),
                  ...q.windows.map((w) => `${w.name.padEnd(10)} ${Math.round(w.used * 100)}% used${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : ""}`),
                  ...Object.entries(q.raw).map(([k, v]) => `${k}: ${v}`),
                ].join("\n"),
            })
          }
          const s = spend(sessionFiles(join(getAgentDir(), "sessions"), now), now)
          if (s.month.tokens) {
            rows.push(
              { label: line("spend, last 24 hours", s.today) },
              { label: line("spend, last 7 days", s.week) },
              { label: line("spend, last 30 days", s.month) },
            )
            const sorted = (m: Map<string, Usage>) => [...m].sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens)
            for (const [model, u] of sorted(s.byModel)) rows.push({ label: line(`  ${model}`, u), dim: true })
            for (const [source, u] of sorted(s.bySource)) rows.push({ label: line(`  ${source} (other sessions)`, u), dim: true })
          }
          return rows
        },
      })
    },
  })
}
