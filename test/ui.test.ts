import assert from "node:assert/strict"
import { test } from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import { line, orderStatuses, tint, tone } from "../extensions/ui/ui.ts"

test("tone: green under half, nothing to 70, yellow to 90, red from 90", () => {
  assert.deepEqual([0, 49, 50, 69, 70, 89, 90, 100].map(tone), ["success", "success", undefined, undefined, "warning", "warning", "error", "error"])
})

test("tint colours each percentage and leaves the rest", () => {
  assert.equal(tint("budget 0% · 5h 75% · 7d 60% · 9.5%", (t, s) => `<${t}>${s}`), "budget <success>0% · 5h <warning>75% · 7d 60% · <success>9.5%")
})

test("plan and tasks come first, the rest keep their order", () => {
  const m = new Map([["budget", "b"], ["usage", "u"], ["tasks", "t"], ["plan", "p"]])
  assert.deepEqual(orderStatuses(m).map(([k]) => k), ["plan", "tasks", "budget", "usage"])
})

test("line: right part flush right; left parts dropped from the end, then the right cut", () => {
  assert.equal(line(["a", "b"], "R", 10, "|"), "a|b      R")
  assert.equal(line(["aaaa", "bbbb", "cccc"], "RR", 13, "|"), "aaaa|bbbb  RR")
  const cut = line(["aaaa", "bbbb"], "RRRRRRRR", 10, "|")
  assert.ok(cut.startsWith("aaaa  RRR") && cut.includes("…"))
  assert.equal(visibleWidth(cut), 10)
  assert.equal(visibleWidth(line(["aaaaaaaaaaaa"], "R", 8, "|")), 8)
})
