import assert from "node:assert/strict"
import { test } from "node:test"
import { checkFindings, parseFindings, silentFiles } from "../extensions/tasks/findings.ts"

const REVIEW = `Some preamble the model wrote.
src/a.ts:3  blocker  the loop skips the last item. Use <=.  \`for (let i = 0; i < n - 1; i++) {\`
src/b.ts:10 major    \`retry\` never backs off. Sleep between tries.  \`  retry(fn)\`
- src/a.ts:40  minor  a comment restates the code.  \`// add one\`
src/a.ts:7  nit  not a severity  \`x\`
src/c.ts  minor  no line  \`y\`
No findings in: src/d.ts.
3 findings. Blocking: 1.`

test("parseFindings: path:line severity text `quote`, other lines ignored", () => {
  assert.deepEqual(parseFindings(REVIEW), [
    { path: "src/a.ts", line: 3, severity: "blocker", text: "the loop skips the last item. Use <=.", quote: "for (let i = 0; i < n - 1; i++) {" },
    { path: "src/b.ts", line: 10, severity: "major", text: "`retry` never backs off. Sleep between tries.", quote: "  retry(fn)" },
    { path: "src/a.ts", line: 40, severity: "minor", text: "a comment restates the code.", quote: "// add one" },
  ])
})

test("checkFindings: a quote must be in the file at or near its line", () => {
  const files: Record<string, string> = {
    "src/a.ts": ["const n = xs.length", "", "for (let i = 0; i < n - 1; i++) {", ...Array(40).fill("x"), "// add one"].join("\n"),
    "src/b.ts": Array(9).fill("").concat(["  retry(fn) // keep"]).join("\n"),
  }
  const { kept, dropped } = checkFindings(parseFindings(REVIEW), (p) => files[p])
  assert.deepEqual(kept.map((f) => `${f.path}:${f.line}`), ["src/a.ts:3", "src/b.ts:10"])
  assert.deepEqual(dropped.map((f) => `${f.path}:${f.line}`), ["src/a.ts:40"]) // "// add one" sits at line 44, too far
  const near = checkFindings([{ path: "src/a.ts", line: 6, severity: "minor", text: "t", quote: "for (let i" }], (p) => files[p])
  assert.equal(near.kept.length, 1)
  assert.equal(checkFindings([{ path: "gone.ts", line: 1, severity: "minor", text: "t", quote: "x" }], () => undefined).dropped.length, 1)
})

test("silentFiles: changed files no kept finding names", () => {
  const kept = parseFindings(REVIEW).slice(0, 2)
  assert.deepEqual(silentFiles(["src/a.ts", "src/b.ts", "src/d.ts", "README.md"], kept), ["src/d.ts", "README.md"])
})
