import assert from "node:assert/strict"
import { test } from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { Agent } from "../extensions/agents/fleet.ts"
import { conversation, fleet, tree, widget } from "../extensions/agents/view.ts"

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

test("tree: each agent after its parent", () => {
  const agents = [agent("1"), agent("2"), agent("3", { parent: "1", depth: 2 }), agent("4", { parent: "3", depth: 3 })]
  assert.deepEqual(tree(agents).map((a) => a.id), ["1", "3", "4", "2"])
})

test("fleet: main, the agents indented by depth, the selection and the keys", () => {
  const agents = [
    agent("1", { handle: "scout-1", description: "find x", turns: 2, background: false }),
    agent("2", { handle: "locate-1", type: "locate", parent: "1", depth: 2, status: "done", description: "where" }),
  ]
  assert.deepEqual(fleet(agents, undefined, 80, plain), [
    "  main",
    "    scout-1 scout  find x  running foreground 2 turns",
    "      locate-1 locate  where  done 0 turns",
    "  ↓ on an empty prompt to select",
  ])
  const sel = fleet(agents, 1, 80, plain)
  assert.equal(sel[1], "›   scout-1 scout  find x  running foreground 2 turns")
  assert.equal(sel[3], "  enter transcript · x x stop · b background · esc back")
})

test("conversation: the prompt quoted, the text, a line per tool call, failed results", () => {
  const md = conversation([
    { role: "user", content: "find x\nfast", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "toolCall", id: "t", name: "grep", arguments: { pattern: "x" } }] },
    { role: "toolResult", toolCallId: "t", toolName: "grep", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 },
    { role: "toolResult", toolCallId: "u", toolName: "read", content: [{ type: "text", text: "no such file" }], isError: true, timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "a.ts:1" }] },
  ] as never)
  assert.equal(md, '> find x\n> fast\n\nLooking.\n\n`grep` {"pattern":"x"}\n\n`read` failed: no such file\n\na.ts:1')
})
