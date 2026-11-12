import assert from "node:assert/strict"
import { test } from "node:test"
import { type Limits, check, fresh, num, record, summary } from "../home/.pi/agent/extensions/budget/limits.ts"

const L: Limits = { usd: 2, tokens: 1000 }

test("a message reported twice is counted once, at its latest figure", () => {
  const t = fresh()
  record(t, "a", 0.1, 100)
  record(t, "a", 0.3, 400)
  record(t, "b", 0.2, 50)
  assert.equal(t.cost.toFixed(2), "0.50")
  assert.equal(t.tokens, 450)
})

test("warns once per level, only the highest crossed", () => {
  const t = fresh()
  record(t, "a", 0, 100)
  assert.equal(check(t, L), undefined)
  record(t, "a", 0, 260)
  assert.deepEqual(check(t, L), { kind: "warn", level: 0.25 })
  assert.equal(check(t, L), undefined)
  record(t, "a", 0, 800)
  assert.deepEqual(check(t, L), { kind: "warn", level: 0.75 })
  assert.equal(check(t, L), undefined)
})

test("either cap triggers; the hard stop fires once", () => {
  const t = fresh()
  record(t, "a", 2.5, 10)
  assert.deepEqual(check(t, L), { kind: "stop", level: 1 })
  assert.equal(t.stopped, true)
  assert.equal(check(t, L), undefined)
})

test("0 disables a cap; zero cost never trips the dollar cap", () => {
  const t = fresh()
  record(t, "a", 99, 10)
  assert.equal(check(t, { usd: 0, tokens: 1000 }), undefined)
  const s = fresh()
  record(s, "a", 0, 1000)
  assert.equal(check(s, L)?.kind, "stop")
  assert.equal(check(fresh(), { usd: 0, tokens: 0 }), undefined)
  assert.equal(summary(t, { usd: 0, tokens: 1000 }), "10 of 1,000 tokens")
})

test("env parsing", () => {
  assert.equal(num(undefined, 2), 2)
  assert.equal(num("", 2), 2)
  assert.equal(num("abc", 2), 2)
  assert.equal(num("0", 2), 0)
  assert.equal(num("1.5", 2), 1.5)
})
