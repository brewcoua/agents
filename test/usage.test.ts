import assert from "node:assert/strict"
import { test } from "node:test"
import { ago, fromEvent, fromHeaders, merge, parseState, spend, statusLine, windowsLine } from "../extensions/usage/usage.ts"

const NOW = Date.parse("2026-11-13T12:00:00Z")

test("fromHeaders: the Claude bridge's unified windows, fraction and Unix seconds", () => {
  const q = fromHeaders({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": "1794585600",
    "anthropic-ratelimit-unified-7d-utilization": "0.18",
    "content-type": "text/event-stream",
  })
  assert.deepEqual(q?.windows, [
    { name: "5h", used: 0.42, resetsAt: 1794585600_000 },
    { name: "7d", used: 0.18, resetsAt: undefined },
  ])
  assert.equal(q?.status, "allowed")
})

test("fromHeaders and fromEvent: Codex windows, percent and epoch seconds", () => {
  const q = fromHeaders({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1793390439",
    "x-codex-secondary-used-percent": "53",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-plan-type": "plus",
  })
  assert.deepEqual(q?.windows, [
    { name: "5h", used: 1, resetsAt: 1793390439_000 },
    { name: "7d", used: 0.53, resetsAt: undefined },
  ])
  assert.equal(q?.raw["x-codex-plan-type"], "plus")
  const e = fromEvent({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 12.5, window_minutes: 60, reset_at: 1 } } })
  assert.deepEqual(e?.windows, [{ name: "1h", used: 0.125, resetsAt: 1000 }])
  assert.equal(fromEvent({ type: "response.completed" }), undefined)
  assert.equal(fromEvent("text"), undefined)
})

test("fromHeaders: unknown rate-limit headers are kept raw, the rest dropped", () => {
  const q = fromHeaders({ "x-ratelimit-remaining-requests": "99", "x-request-id": "abc", "content-type": "x" })
  assert.deepEqual(q, { windows: [], raw: { "x-ratelimit-remaining-requests": "99" } })
  assert.equal(fromHeaders({ "content-type": "x" }), undefined)
})

test("state: merge stamps the provider, parse survives junk", () => {
  const s = merge(parseState("{bad"), "claude-bridge", { windows: [{ name: "5h", used: 0.5 }], raw: {} }, NOW)
  assert.equal(s["claude-bridge"].at, NOW)
  assert.deepEqual(parseState(JSON.stringify(s)), s)
})

test("windowsLine and statusLine: percent and time to reset", () => {
  const q = { at: NOW, windows: [{ name: "5h", used: 0.42, resetsAt: NOW + 90 * 60_000 }, { name: "7d", used: 0.181 }], raw: {} }
  assert.equal(windowsLine(q, NOW), "5h 42% (1h30m) · 7d 18%")
  assert.equal(statusLine("claude-bridge", q), "claude-bridge 5h 42% · 7d 18%")
  assert.equal(statusLine("x", { at: NOW, windows: [], raw: { a: "1" } }), undefined)
})

test("spend: own messages by model and day window, children by source", () => {
  const day = (h: number) => new Date(NOW - h * 3600_000).toISOString()
  const msg = (h: number, model: string, input: number, output: number, cost: number) =>
    JSON.stringify({ type: "message", timestamp: day(h), message: { role: "assistant", provider: "p", model, usage: { input, output, cost: { total: cost } } } })
  const lines = [
    JSON.stringify({ type: "session", timestamp: day(1) }),
    msg(1, "a", 100, 10, 0.5),
    msg(30, "a", 1000, 0, 1),
    msg(24 * 40, "a", 5, 5, 9), // older than 30 days: out
    JSON.stringify({ type: "custom", customType: "budget-usage", timestamp: day(2), data: { source: "tasks", cost: 0.25, tokens: 50 } }),
    JSON.stringify({ type: "message", timestamp: day(1), message: { role: "user" } }),
    "not json",
  ]
  const s = spend([lines.join("\n")], NOW)
  assert.deepEqual(s.today, { tokens: 160, cost: 0.75 })
  assert.deepEqual(s.week, { tokens: 1160, cost: 1.75 })
  assert.deepEqual(s.month, s.week)
  assert.deepEqual(s.byModel.get("p/a"), { tokens: 1110, cost: 1.5 })
  assert.deepEqual(s.bySource.get("tasks"), { tokens: 50, cost: 0.25 })
})

test("ago and window names: minutes, hours, days", () => {
  assert.deepEqual([ago(10_000), ago(5 * 60_000), ago(120 * 60_000), ago(3 * 86_400_000)], ["now", "5m", "2h", "3d"])
  const e = fromEvent({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 1, window_minutes: 90 }, secondary: { used_percent: 2 }, x: {} } })
  assert.deepEqual(e?.windows.map((w) => w.name), ["90m", "secondary"])
  assert.equal(fromEvent({ type: "codex.rate_limits", rate_limits: {} }), undefined)
  assert.deepEqual(parseState("[1]"), {})
  assert.deepEqual(parseState("null"), {})
})
