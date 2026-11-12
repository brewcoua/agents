import assert from "node:assert/strict"
import { test } from "node:test"
import { capDiff, parseArgs } from "../home/.pi/agent/extensions/simplify/diff.ts"

const file = (name: string, body: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`

test("args: none, one ref, blank", () => {
  assert.deepEqual(parseArgs(""), { ref: undefined })
  assert.deepEqual(parseArgs("  "), { ref: undefined })
  assert.deepEqual(parseArgs(" HEAD~2 "), { ref: "HEAD~2" })
})

test("args: more than one word or an option is an error", () => {
  assert.ok("error" in parseArgs("a b"))
  assert.ok("error" in parseArgs("--output=x"))
})

test("cap: under the limit keeps everything", () => {
  const d = file("a.ts", "+x") + file("b.ts", "+y")
  assert.deepEqual(capDiff(d, 10_000), { text: d, omitted: [] })
})

test("cap: whole files are dropped and named, in order", () => {
  const a = file("a.ts", "+x")
  const big = file("src/big file.ts", "+" + "z".repeat(500))
  const c = file("c.ts", "+y")
  const r = capDiff(a + big + c, a.length + c.length)
  assert.equal(r.text, a + c)
  assert.deepEqual(r.omitted, ["src/big file.ts"])
})

test("cap: empty diff", () => {
  assert.deepEqual(capDiff("", 10), { text: "", omitted: [] })
})
