import assert from "node:assert/strict"
import { test } from "node:test"
import { type Limits, addOther, check, fresh, num, own, record, status, summary } from "../extensions/budget/limits.ts"

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

test("usage of other sessions counts toward the caps, by source", () => {
  const t = fresh()
  record(t, "a", 0, 100)
  addOther(t, "tasks", { cost: 0.5, tokens: 300 })
  addOther(t, "tasks", { cost: 0, tokens: 100 })
  addOther(t, "btw", { cost: 0, tokens: 50 })
  assert.equal(t.tokens, 550)
  assert.deepEqual(own(t), { cost: 0, tokens: 100 })
  assert.deepEqual(t.others.get("tasks"), { cost: 0.5, tokens: 400 })
  record(t, "a", 0, 150) // a message re-reported keeps the others
  assert.equal(t.tokens, 600)
})

test("status line", () => {
  const t = fresh()
  record(t, "a", 0, 610_000)
  assert.equal(status(t, { usd: 2, tokens: 5_000_000 }), "budget 12% · 610k/5M tok")
  record(t, "b", 0.5, 1_000_000)
  assert.equal(status(t, { usd: 2, tokens: 5_000_000 }), "budget 32% · 1.6M/5M tok · $0.50/$2.00")
  assert.equal(status(t, { usd: 0, tokens: 0 }), "budget 0%")
})
