import assert from "node:assert/strict"
import { test } from "node:test"
import { type Agent, find, live, newHandle, report, startable, subtree } from "../extensions/agents/fleet.ts"

const agent = (id: string, o: Partial<Agent> = {}): Agent => ({
  id, handle: `h${id}`, type: "scout", description: "", parent: "main", depth: 1, background: true, status: "queued", turns: 0, tokens: 0, cost: 0, ...o,
})

test("handles: the name given, unique, or the type numbered", () => {
  const agents = [agent("1", { handle: "scout-1" }), agent("2", { handle: "x" })]
  assert.equal(newHandle(agents, "scout"), "scout-2")
  assert.equal(newHandle(agents, "locate"), "locate-1")
  assert.equal(newHandle(agents, "scout", "y"), "y")
  assert.deepEqual(newHandle(agents, "scout", "x"), { error: "an agent is already called x" })
})

test("find by id or handle; live means queued or running", () => {
  const agents = [agent("1"), agent("2", { status: "done" })]
  assert.equal(find(agents, "h2")?.id, "2")
  assert.equal(find(agents, "1")?.id, "1")
  assert.equal(find(agents, "z"), undefined)
  assert.deepEqual(agents.map(live), [true, false])
})

test("startable: oldest first, up to the limit at each depth", () => {
  const agents = [
    agent("1", { status: "running" }),
    agent("2"),
    agent("3"),
    agent("4", { depth: 2 }),
    agent("5", { depth: 2, status: "done" }),
  ]
  assert.deepEqual(startable(agents, 2).map((a) => a.id), ["2", "4"])
  assert.equal(agents[1].status, "queued", "startable does not change the agents")
  assert.deepEqual(startable(agents, 1).map((a) => a.id), ["4"])
})

test("subtree: the agent and everything under it", () => {
  const agents = [agent("1"), agent("2", { parent: "1" }), agent("3", { parent: "2" }), agent("4")]
  assert.deepEqual(subtree(agents, "1").map((a) => a.id), ["1", "2", "3"])
  assert.deepEqual(subtree(agents, "9"), [])
})

test("report says where the agent is, and its result when it ended", () => {
  const a = agent("7", { handle: "scout-1" })
  assert.equal(report(a), "Agent scout-1 (scout, id 7) is queued.")
  assert.equal(report({ ...a, status: "running", turns: 2, tool: "grep" }), "Agent scout-1 (scout, id 7) is running: 2 turns so far, now grep.")
  assert.equal(report({ ...a, status: "running", turns: 0 }), "Agent scout-1 (scout, id 7) is running: 0 turns so far.")
  assert.equal(report({ ...a, status: "done", result: "found it" }), "Agent scout-1 (scout, id 7) finished:\n\nfound it")
  assert.equal(report({ ...a, status: "stopped", error: "turn limit" }), "Agent scout-1 (scout, id 7) was stopped (turn limit):\n\n(no text)")
  assert.equal(report({ ...a, status: "failed", error: "boom" }), "Agent scout-1 (scout, id 7) failed: boom")
  assert.equal(report({ ...a, status: "failed" }), "Agent scout-1 (scout, id 7) failed: unknown error")
})

test("report names the branch of an agent that worked in a worktree", () => {
  const a = agent("7", { handle: "impl-1", status: "done", result: "done", worktree: "/p/w", branch: "agent-7" })
  assert.equal(report(a), "Agent impl-1 (scout, id 7) finished:\n\ndone\n\nIts changes are committed on branch agent-7, in /p/w.")
})
