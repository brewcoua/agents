import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type Limits, check, fresh, num, record, summary } from "./limits.ts"

const LIMITS: Limits = {
  usd: num(process.env.PI_BUDGET_USD, 2),
  tokens: num(process.env.PI_BUDGET_TOKENS, 5_000_000),
}

export default function (pi: ExtensionAPI) {
  let totals = fresh()
  pi.on("session_start", () => {
    totals = fresh()
  })

  // Cost is usage.cost.total: the provider's billed cost when it reports one, else the
  // catalog estimate. A model without a catalog price (the Claude bridge, local models)
  // costs 0, so only the token cap can stop those. Reasoning tokens are part of output.
  pi.on("message_end", (event, ctx) => {
    const m = event.message
    if (m.role !== "assistant") return
    record(totals, m.responseId ?? String(m.timestamp), m.usage.cost.total, m.usage.input + m.usage.output)

    const r = check(totals, LIMITS)
    if (!r) return
    ctx.ui.notify(
      r.kind === "stop"
        ? `Budget reached: ${summary(totals, LIMITS)}. Tool calls are blocked.`
        : `Budget at ${r.level * 100}%: ${summary(totals, LIMITS)}.`,
      r.kind === "stop" ? "error" : "warning",
    )
  })

  pi.on("tool_call", () => {
    if (!totals.stopped) return undefined
    return {
      block: true,
      reason: `Session budget exhausted: ${summary(totals, LIMITS)}. Stop. Report what is done, what is verified, and what remains, then let the user decide whether to continue.`,
    }
  })
}
