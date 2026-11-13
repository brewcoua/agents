import assert from "node:assert/strict"
import { test } from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { Agent } from "../extensions/agents/fleet.ts"
import { widget } from "../extensions/agents/view.ts"

const agent = (id: string, o: Partial<Agent> = {}): Agent => ({
  id, handle: `h${id}`, type: "scout", description: "", parent: "main", depth: 1, background: true, status: "running", turns: 0, tokens: 0, cost: 0, ...o,
})
const plain = (_c: string, s: string) => s

test("widget: a line per running agent with its tool, tokens and context", () => {
  const agents = [agent("1", { tool: "grep", tokens: 12_400, context: 14.6 }), agent("2", { status: "queued" }), agent("3")]
  assert.deepEqual(widget(agents, 1, 80, plain), ["⠙ h1 · grep · 12k tok · ctx 15%", "⠙ h3 · thinking · 0 tok"])
})

test("widget: the context percent takes its tone; the line fits the width", () => {
  const [l] = widget([agent("1", { context: 95 })], 0, 80, (c, s) => (c === "error" ? `<${s}>` : s))
  assert.ok(l.endsWith("ctx <95%>"))
  const [cut] = widget([agent("1")], 0, 6, plain)
  assert.ok(cut.startsWith("⠋ h1 ") && visibleWidth(cut) === 6)
})
