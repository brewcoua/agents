import assert from "node:assert/strict"
import { test } from "node:test"
import {
  format,
  indexLine,
  indexMessage,
  parse,
  removeFromIndex,
  slug,
  upsertIndex,
  type Memory,
} from "../home/.pi/agent/extensions/memory/memory.ts"

const m: Memory = { name: "Commit on master", description: "never branch\nbefore commit", type: "feedback", body: "Why: user rule.\n" }

test("slug: file name from a title", () => {
  assert.equal(slug("Commit on master"), "commit-on-master")
  assert.equal(slug("  Repos are sha256! "), "repos-are-sha256")
  assert.equal(slug("***"), "")
})

test("format and parse round-trip, description on one line", () => {
  const text = format(m)
  assert.equal(text, "---\nname: Commit on master\ndescription: never branch before commit\ntype: feedback\n---\n\nWhy: user rule.\n")
  assert.deepEqual(parse(text), { ...m, description: "never branch before commit", body: "Why: user rule." })
})

test("parse rejects missing fields, unknown type, no frontmatter", () => {
  assert.equal(parse("no frontmatter"), undefined)
  assert.equal(parse("---\nname: a\ndescription: b\ntype: nope\n---\nx"), undefined)
  assert.equal(parse("---\nname: a\ntype: user\n---\nx"), undefined)
})

test("index: one line per memory, update in place, remove", () => {
  const a = indexLine(m, "commit-on-master.md")
  assert.equal(a, "- [Commit on master](commit-on-master.md) — never branch before commit")
  let idx = upsertIndex("", "commit-on-master.md", a)
  idx = upsertIndex(idx, "other.md", "- [Other](other.md) — x")
  idx = upsertIndex(idx, "commit-on-master.md", "- [Commit on master](commit-on-master.md) — new")
  assert.equal(idx, "- [Commit on master](commit-on-master.md) — new\n- [Other](other.md) — x\n")
  assert.equal(removeFromIndex(idx, "commit-on-master.md"), "- [Other](other.md) — x\n")
  assert.equal(removeFromIndex("- [Other](other.md) — x\n", "other.md"), "")
  assert.equal(removeFromIndex("", "other.md"), "")
})

test("indexMessage: nothing when both indexes are empty", () => {
  assert.equal(indexMessage("", " \n"), undefined)
  const t = indexMessage("- [A](a.md) — x\n", "")!
  assert.match(t, /Global memories[\s\S]*- \[A\]\(a\.md\)/)
  assert.doesNotMatch(t, /Project memories/)
})
