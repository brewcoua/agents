// The advisor's handoff, as rpiv-advisor makes it: the session's own context, minus what a
// provider would refuse or what would let the advisor call tools.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai"

export const NAME = "advisor"

export const PROMPT = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs.`

const NUDGE = "Please advise on the executor's situation above."

export function handoff(messages: Message[]): Message[] {
  // Pi records the tool loadout as deltas on system messages, and providers declare tools from
  // them, so `tools: []` alone would leave the executor's tools callable.
  let out = messages.map((m) => {
    if (m.role !== "system" || (!m.toolsAdded && !m.toolsRemoved)) return m
    const { toolsAdded: _a, toolsRemoved: _r, ...rest } = m
    return rest
  })
  // The advisor call that is running has no result yet; providers reject an orphan tool call.
  const last = out.at(-1)
  if (last?.role === "assistant") {
    const content = last.content.filter((c) => !(c.type === "toolCall" && c.name === NAME))
    out = content.length ? [...out.slice(0, -1), { ...last, content }] : out.slice(0, -1)
  }
  // Some providers refuse a conversation that ends on an assistant turn.
  if (out.at(-1)?.role === "assistant") out = [...out, { role: "user", content: [{ type: "text", text: NUDGE }], timestamp: Date.now() }]
  return out
}

export const textOf = (r: AssistantMessage) =>
  r.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trim()
