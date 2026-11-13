import assert from "node:assert/strict"
import { test } from "node:test"
import type { Agent } from "../extensions/agents/fleet.ts"
import { END, META, descendants, end, inherited, meta, restore } from "../extensions/agents/saved.ts"

const agent: Agent = {
  id: "7", handle: "scout-1", type: "scout", description: "find x", parent: "main", depth: 1, background: false, status: "done",
  turns: 3, tokens: 900, cost: 0.02, result: "a.ts:1", tool: "grep", cwd: "/p", worktree: "/p/.pi/worktrees/agent-7", branch: "agent-7",
}
const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data })

test("an agent round-trips through its session's entries, the last end winning", () => {
  const entries = [{ type: "message" }, entry(META, meta(agent)), entry(END, { ...end(agent), status: "stopped" }), entry(END, end(agent))]
  assert.deepEqual(restore(entries, "/s/7.jsonl", "a.ts:1"), {
    id: "7", handle: "scout-1", type: "scout", description: "find x", parent: "main", depth: 1, owner: undefined, cwd: "/p", worktree: "/p/.pi/worktrees/agent-7", branch: "agent-7",
    background: true, status: "done", error: undefined, turns: 3, tokens: 900, cost: 0.02, result: "a.ts:1", sessionFile: "/s/7.jsonl",
  })
})

test("restore: no meta is not an agent; no end means Pi died while it ran", () => {
  assert.equal(restore([{ type: "message" }], "f", ""), undefined)
  const a = restore([entry(META, meta(agent))], "f", "")
  assert.deepEqual([a?.status, a?.error, a?.turns], ["stopped", "Pi exited while it ran", 0])
})

test("descendants: children, then theirs, others left out", () => {
  const headers = [{ file: "a", parent: "main" }, { file: "b", parent: "a" }, { file: "c", parent: "other" }, { file: "main" }, { file: "d", parent: "main" }]
  assert.deepEqual(descendants(headers, "main"), ["a", "d", "b"])
})

test("inherited: no system messages, no unanswered tool calls, no empty assistant turns", () => {
  const user = { role: "user", content: "go", timestamp: 0 }
  const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} })
  const out = inherited([
    { role: "system", content: "tools", timestamp: 0 },
    user,
    { role: "assistant", content: [call("1", "read")] },
    { role: "toolResult", toolCallId: "1", toolName: "read", content: [], isError: false, timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "now" }, call("2", "agent"), call("3", "read")] },
    { role: "assistant", content: [call("4", "agent")] },
  ] as never)
  assert.deepEqual(out.map((m) => [m.role, m.role === "assistant" ? m.content.map((c) => (c.type === "toolCall" ? c.id : c.type)) : undefined]), [
    ["user", undefined],
    ["assistant", ["1"]],
    ["toolResult", undefined],
    ["assistant", ["text"]],
  ])
})
