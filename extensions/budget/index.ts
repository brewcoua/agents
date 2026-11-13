import { writeFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { showList } from "../lib/view.ts"
import { type Limits, USAGE_EVENT, type Usage, addOther, check, count, fraction, fresh, num, own, record, status, summary, usd } from "./limits.ts"

const LIMITS: Limits = {
  usd: num(process.env.PI_BUDGET_USD, 2),
  tokens: num(process.env.PI_BUDGET_TOKENS, 5_000_000),
}

// Usage of other sessions this one started is stored as a session entry, so a resumed session
// counts it again.
const ENTRY = "budget-usage"

// Set by the tasks extension in a child pi: where to write this session's usage for the parent.
const REPORT = process.env.OTHALA_BUDGET_REPORT

export default function (pi: ExtensionAPI) {
  let totals = fresh()
  let ui: ExtensionContext | undefined // for usage that arrives outside any event of this session

  // Cost is usage.cost.total: the provider's billed cost when it reports one, else the
  // catalog estimate. A model without a catalog price (the Claude bridge, local models)
  // costs 0, so only the token cap can stop those. Reasoning tokens are part of output.
  const count1 = (m: any) => record(totals, m.responseId ?? String(m.timestamp), m.usage.cost.total, m.usage.input + m.usage.output)

  const update = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("budget", status(totals, LIMITS))
    const r = check(totals, LIMITS)
    if (!r) return
    ctx.ui.notify(
      r.kind === "stop"
        ? `Budget reached: ${summary(totals, LIMITS)}. Tool calls are blocked.`
        : `Budget at ${r.level * 100}%: ${summary(totals, LIMITS)}.`,
      r.kind === "stop" ? "error" : "warning",
    )
  }

  // A resumed session starts from what its history already spent.
  pi.on("session_start", (_e, ctx) => {
    ui = ctx
    totals = fresh()
    for (const e of ctx.sessionManager.getEntries() as any[]) {
      if (e.type === "message" && e.message.role === "assistant" && e.message.usage) count1(e.message)
      else if (e.type === "custom" && e.customType === ENTRY && e.data) addOther(totals, e.data.source, e.data)
    }
    update(ctx)
  })

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return
    count1(event.message)
    if (REPORT) writeFileSync(REPORT, JSON.stringify(own(totals)))
    update(ctx)
  })

  pi.events.on(USAGE_EVENT, (data: unknown) => {
    const u = data as Usage & { source: string }
    if (!u || !(u.cost > 0 || u.tokens > 0)) return
    addOther(totals, u.source, u)
    pi.appendEntry(ENTRY, { source: u.source, cost: u.cost, tokens: u.tokens })
    if (ui) update(ui)
  })

  pi.on("tool_call", () => {
    if (!totals.stopped) return undefined
    return {
      block: true,
      reason: `Session budget exhausted: ${summary(totals, LIMITS)}. Stop. Report what is done, what is verified, and what remains, then let the user decide whether to continue.`,
    }
  })

  pi.registerCommand("budget", {
    description: "What this session spent against its budget, with the task runs, scouts and /btw it started",
    handler: async (_args, ctx) => {
      const line = (name: string, u: Usage) => `${name.padEnd(10)} ${count(u.tokens).padStart(12)} tokens  ${usd(u.cost)}`
      const cap = (n: number, f: (n: number) => string) => (n > 0 ? f(n) : "off")
      await showList(ctx, {
        title: "Budget",
        empty: "",
        rows: () => [
          { label: `${Math.floor(fraction(totals, LIMITS) * 100)}% of the nearest cap${totals.stopped ? "; reached, tool calls are blocked" : ""}` },
          { label: `${"caps".padEnd(10)} ${cap(LIMITS.tokens, count).padStart(12)} tokens  ${cap(LIMITS.usd, usd)}  (PI_BUDGET_TOKENS, PI_BUDGET_USD)`, dim: true },
          { label: line("session", own(totals)) },
          ...[...totals.others].map(([source, u]) => ({ label: line(source, u) })),
          { label: line("total", totals) },
        ],
      })
    },
  })
}
