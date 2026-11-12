import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { Rules } from "../home/.pi/agent/extensions/guardrails/rules.ts"
import {
  PLAN_FORMAT, commentsMessage, isSmall, parseComments, parsePlan, planStatus, planVerdict, slug, uniqueSlug, withStatus,
} from "../home/.pi/agent/extensions/tasks/plan.ts"
import { clip, formatScouts, scoutArgs } from "../home/.pi/agent/extensions/tasks/scout.ts"
import { parseTiers, splitModel } from "../home/.pi/agent/extensions/tasks/tiers.ts"

const here = (p: string) => new URL(`../home/.pi/agent/${p}`, import.meta.url)
const rules: Rules = JSON.parse(readFileSync(here("extensions/guardrails/rules.json"), "utf8"))

test("slug: lowercase words, bounded, never empty", () => {
  assert.equal(slug("Add a DNF backend!"), "add-a-dnf-backend")
  assert.equal(slug("  ../../etc  "), "etc")
  assert.equal(slug("???"), "plan")
  assert.ok(slug("x".repeat(100)).length <= 48)
  assert.equal(uniqueSlug("a", (s) => s === "a" || s === "a-2"), "a-3")
  assert.equal(uniqueSlug("a", () => false), "a")
})

test("tiers: the shipped file parses to the bridge's three families", () => {
  const t = parseTiers(readFileSync(here("tasks.json"), "utf8"))
  assert.deepEqual(t.plan, { provider: "claude-bridge", id: "claude-opus-5-5" })
  assert.deepEqual(t.large, { provider: "claude-bridge", id: "claude-sonnet-5-5" })
  assert.deepEqual(t.small, { provider: "claude-bridge", id: "claude-haiku-5-5" })
  assert.equal(t.maxConcurrent, 3)
})

test("tiers: invalid files say what is wrong", () => {
  assert.deepEqual(splitModel("ollama/qwen2.5-coder:7b"), { provider: "ollama", id: "qwen2.5-coder:7b" })
  assert.throws(() => splitModel("nomodel"), /provider\/model/)
  const ok = { plan: "a/b", large: "a/b", small: "a/b", maxConcurrent: 2 }
  assert.throws(() => parseTiers(JSON.stringify({ ...ok, small: undefined })), /"small"/)
  assert.throws(() => parseTiers(JSON.stringify({ ...ok, maxConcurrent: 0 })), /maxConcurrent/)
  assert.equal(parseTiers(JSON.stringify(ok)).maxConcurrent, 2)
})

const PLAN = `---
status: draft
---
# DNF backend

## Goal
Install packages on Fedora.

## Tasks
### 1 Trait
- files: src/pkg.rs, src/lib.rs
- tier: large
- verify: cargo test pkg::
- accept: the trait exists

### 1.1 dnf backend
- deps: 1
- files: src/dnf.rs
- tier: small
- verify: cargo test dnf::
- accept: dnf installs the listed packages
`

test("parsePlan: header fields and tasks as the task JSON wants them", () => {
  const p = parsePlan(PLAN)
  assert.deepEqual(p.errors, [])
  assert.equal(p.status, "draft")
  assert.equal(p.title, "DNF backend")
  assert.deepEqual(p.tasks[0], {
    id: "1", title: "Trait", deps: [], files: ["src/pkg.rs", "src/lib.rs"], tier: "large",
    verify: "cargo test pkg::", accept: "the trait exists",
  })
  assert.deepEqual(p.tasks[1], {
    id: "1.1", parent: "1", title: "dnf backend", deps: ["1"], files: ["src/dnf.rs"], tier: "small",
    verify: "cargo test dnf::", accept: "dnf installs the listed packages",
  })
  assert.equal(isSmall(p), false)
})

test("the format shown to the model names every field the parser reads", () => {
  for (const key of ["deps", "files", "tier", "verify", "accept", "parent"]) assert.match(PLAN_FORMAT, new RegExp(`- ${key}:`))
  assert.match(PLAN_FORMAT, /^### 1 </m)
})

test("parsePlan: no task list is a small plan; broken tasks are listed", () => {
  const none = parsePlan("# T\n\n## Goal\nx\n")
  assert.deepEqual(none.errors, [])
  assert.equal(isSmall(none), true)
  const bad = parsePlan("# T\n## Tasks\n### 1 a\n- tier: huge\n- files: a\n### 1 b\n- deps: 9\n- files: b\n- tier: small\n- verify: v\n- accept: a\n")
  assert.ok(bad.errors.some((e) => /task 1: missing verify, accept/.test(e)))
  assert.ok(bad.errors.some((e) => /tier must be large or small/.test(e)))
  assert.ok(bad.errors.some((e) => /used twice/.test(e)))
  assert.ok(bad.errors.some((e) => /unknown dependency 9/.test(e)))
  assert.ok(parsePlan("no title").errors.some((e) => /Title/.test(e)))
})

test("status lives in the frontmatter", () => {
  assert.equal(planStatus(PLAN), "draft")
  const approved = withStatus(PLAN, "approved")
  assert.equal(planStatus(approved), "approved")
  assert.equal(approved.replace("approved", "draft"), PLAN)
  assert.equal(planStatus(withStatus("# T\n", "approved")), "approved")
  assert.equal(withStatus("---\nother: 1\n---\n# T\n", "approved"), "---\nstatus: approved\nother: 1\n---\n# T\n")
})

test("parseComments: >> lines under the > lines they follow", () => {
  const text = [
    "# T", "", "> Install with dnf", "> in a loop", ">> do it in one call", ">> and say why", "", "plain",
    ">> orphan, no quote", "> quoted again", ">> ", "> last", ">> last one",
  ].join("\n")
  assert.deepEqual(parseComments(text), [
    { quote: "Install with dnf\nin a loop", comment: "do it in one call\nand say why" },
    { quote: "", comment: "orphan, no quote" },
    { quote: "last", comment: "last one" },
  ])
  assert.deepEqual(parseComments(PLAN), [])
})

test("commentsMessage quotes the lines and numbers the comments", () => {
  const m = commentsMessage(".pi/plans/a.md", [{ quote: "line one", comment: "why?" }, { quote: "", comment: "more" }])
  assert.match(m, /left 2 comments/)
  assert.match(m, /1\. On:\n   > line one\n   Comment: why\?/)
  assert.match(m, /2\. Comment: more/)
})

test("plan mode: edit and write only under .pi/plans", () => {
  const v = (tool: string, path: string) => planVerdict(rules, tool, { path }, "/work").verdict
  assert.equal(v("write", ".pi/plans/a.md"), "allow")
  assert.equal(v("edit", "/work/.pi/plans/a.md"), "allow")
  assert.equal(v("write", "src/a.ts"), "deny")
  assert.equal(v("edit", ".pi/plans/../../src/a.ts"), "deny")
  assert.equal(v("write", "/etc/passwd"), "deny")
  assert.equal(v("write", ".pi/plans-x/a.md"), "deny")
  assert.equal(v("write", ".pi/plans"), "deny")
})

test("plan mode: bash must be plainly allowed by guardrails; ask is deny", () => {
  const v = (command: string) => planVerdict(rules, "bash", { command }, "/work")
  assert.equal(v("git log --oneline | head").verdict, "allow")
  assert.equal(v("rg foo src").verdict, "allow")
  assert.equal(v("touch a").verdict, "deny")
  assert.equal(v("git push").verdict, "deny")
  assert.equal(v("echo x > out.txt").verdict, "deny")
  assert.equal(v("cat $(ls)").verdict, "deny")
  assert.equal(v("rm -rf /").verdict, "deny")
  assert.match(v("touch a").reason, /plan mode/)
})

test("plan mode: tools", () => {
  const v = (tool: string) => planVerdict(rules, tool, {}, "/work").verdict
  for (const t of ["read", "grep", "find", "ls", "scout", "ask_user_question"]) assert.equal(v(t), "allow", t)
  for (const t of ["memory_save", "mcp__x__y", "codemode"]) assert.equal(v(t), "deny", t)
})

test("scout: a read-only child pi on the small tier", () => {
  const args = scoutArgs({ provider: "claude-bridge", id: "claude-haiku-5-5" }, "where is X?")
  assert.deepEqual(args.slice(0, 4), ["-p", "--no-session", "--no-mcp", "-na"])
  assert.equal(args[args.indexOf("-t") + 1], "read,grep,find,ls")
  assert.equal(args[args.indexOf("--provider") + 1], "claude-bridge")
  assert.equal(args[args.indexOf("--model") + 1], "claude-haiku-5-5")
  assert.match(args.at(-1)!, /Question: where is X\?$/)
})

test("scout results: text, failures, and the output cap", () => {
  assert.equal(clip("abc", 5), "abc")
  assert.match(clip("abcdef", 3), /^abc\n\[cut: 3 more/)
  const out = formatScouts(["q1", "q2", "q3"], [
    { code: 0, killed: false, stdout: "found it\n", stderr: "" },
    { code: 1, killed: false, stdout: "", stderr: "boom\n" },
    { code: null, killed: true, stdout: "", stderr: "" },
  ])
  assert.match(out, /## Scout 1: q1\nfound it$/m)
  assert.match(out, /## Scout 2: q2\nfailed \(exit 1\): boom/)
  assert.match(out, /## Scout 3: q3\nfailed: timed out/)
})
