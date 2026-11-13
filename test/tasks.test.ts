import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { Rules } from "../extensions/guardrails/rules.ts"
import {
  PLAN_FORMAT, acceptanceReport, buildArgs, commentsMessage, isSmall, modePrompt, parseComments, parsePlan, planStatus, planVerdict,
  slug, uniqueSlug, withStatus,
} from "../extensions/tasks/plan.ts"
import { SCOUT, clip, formatScouts } from "../extensions/tasks/scout.ts"

const here = (p: string) => new URL(`../${p}`, import.meta.url)
const rules: Rules = JSON.parse(readFileSync(here("extensions/guardrails/rules.json"), "utf8"))

test("slug: lowercase words, bounded, never empty", () => {
  assert.equal(slug("Add a DNF backend!"), "add-a-dnf-backend")
  assert.equal(slug("  ../../etc  "), "etc")
  assert.equal(slug("???"), "plan")
  assert.ok(slug("x".repeat(100)).length <= 48)
  assert.equal(uniqueSlug("a", (s) => s === "a" || s === "a-2"), "a-3")
  assert.equal(uniqueSlug("a", () => false), "a")
})

const PLAN = `---
status: draft
---
# DNF backend

## Goal
Install packages on Fedora.

## Acceptance
- a1: \`cargo test --test dnf\` exits 0
- a2: manual: the help names dnf
- a3: deferred: no Fedora CI yet

## Tasks
### 1 Trait
- files: src/pkg.rs, src/lib.rs
- role: large
- mode: direct: a trait has no behaviour to test
- spec: the trait exists
- verify: cargo test pkg::
- covers: a2

### 1.1 dnf backend
- deps: 1
- files: src/dnf.rs, tests/*.rs
- tests: tests/dnf.rs
- role: small
- mode: tdd
- spec: dnf installs the listed packages
- verify: cargo test dnf::
- covers: a1
`

test("parsePlan: header fields and tasks as the task JSON wants them", () => {
  const p = parsePlan(PLAN)
  assert.deepEqual(p.errors, [])
  assert.equal(p.status, "draft")
  assert.equal(p.title, "DNF backend")
  assert.deepEqual(p.acceptance, [
    { id: "a1", kind: "command", text: "cargo test --test dnf" },
    { id: "a2", kind: "manual", text: "the help names dnf" },
    { id: "a3", kind: "deferred", text: "no Fedora CI yet" },
  ])
  assert.deepEqual(p.tasks[0], {
    id: "1", title: "Trait", deps: [], files: ["src/pkg.rs", "src/lib.rs"], tests: [], role: "large",
    mode: "direct: a trait has no behaviour to test", spec: "the trait exists", verify: "cargo test pkg::", covers: ["a2"],
  })
  assert.deepEqual(p.tasks[1], {
    id: "1.1", parent: "1", title: "dnf backend", deps: ["1"], files: ["src/dnf.rs", "tests/*.rs"], tests: ["tests/dnf.rs"],
    role: "small", mode: "tdd", spec: "dnf installs the listed packages", verify: "cargo test dnf::", covers: ["a1"],
  })
  assert.equal(isSmall(p), false)
})

test("the format shown to the model names every field the parser reads", () => {
  for (const key of ["deps", "files", "tests", "role", "mode", "spec", "verify", "covers", "parent", "a1", "a2", "a3"]) assert.match(PLAN_FORMAT, new RegExp(`- ${key}:`))
  assert.match(PLAN_FORMAT, /^### 1 </m)
})

test("parsePlan: no task list is a small plan; broken tasks are listed", () => {
  const none = parsePlan("# T\n\n## Goal\nx\n")
  assert.deepEqual(none.errors, [])
  assert.equal(isSmall(none), true)
  const bad = parsePlan("# T\n## Tasks\n### 1 a\n- role: huge\n- files: a\n### 1 b\n- deps: 9\n- files: b\n- role: small\n- mode: direct: x\n- spec: s\n- verify: v\n")
  assert.ok(bad.errors.some((e) => /task 1: missing mode, spec, verify/.test(e)))
  assert.ok(bad.errors.some((e) => /role must be large or small/.test(e)))
  assert.ok(bad.errors.some((e) => /used twice/.test(e)))
  assert.ok(bad.errors.some((e) => /unknown dependency 9/.test(e)))
  assert.ok(parsePlan("no title").errors.some((e) => /Title/.test(e)))
})

test("parsePlan: modes, tests and acceptance coverage", () => {
  const errors = (text: string) => parsePlan(text).errors
  const one = (fields: string, acceptance = "- a1: `true` exits 0") =>
    errors(`# T\n## Acceptance\n${acceptance}\n## Tasks\n### 1 a\n- files: src/a, tests/a\n- role: small\n- spec: s\n- verify: v\n${fields}`)
  assert.deepEqual(one("- mode: tdd\n- tests: tests/a\n- covers: a1\n"), [])
  assert.match(one("- mode: tdd\n- covers: a1\n").join(), /a tdd task needs tests/)
  assert.match(one("- mode: tdd\n- tests: tests/b\n- covers: a1\n").join(), /tests tests\/b not in its files/)
  assert.match(one("- mode: direct\n- covers: a1\n").join(), /mode must be tdd, or direct: <reason>/)
  assert.match(one("- mode: direct: docs\n").join(), /acceptance a1 is covered by no task/)
  assert.match(one("- mode: direct: docs\n- covers: a1, a9\n").join(), /covers a9, which is no acceptance item/)
  assert.deepEqual(one("- mode: direct: docs\n", "- a1: deferred: later"), [])
  const items = one("- mode: direct: docs\n- covers: a1\n", "- a1: manual: x\n- a1: it works").join()
  assert.match(items, /acceptance a1: not "`<command>` exits 0"/)
  assert.match(items, /acceptance id a1 is used twice/)
  assert.deepEqual(errors("# T\n## Acceptance\n- a1: manual: x\n"), [], "no tasks: the session covers it")
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

test("plan mode: only read-only agent types, never resumed or in a worktree", () => {
  const v = (input: Record<string, unknown>) => planVerdict(rules, "agent", input, "/work")
  for (const type of ["scout", "research", "locate", "precedent"]) assert.equal(v({ type }).verdict, "allow", type)
  assert.match(v({ type: "implement" }).reason, /plan mode: only scout, research, locate, precedent agents/)
  assert.equal(v({ type: "scout", resume: "x" }).verdict, "deny")
  assert.equal(v({ type: "scout", isolation: "worktree" }).verdict, "deny")
  for (const t of ["agent_result", "acceptance_check"]) assert.equal(planVerdict(rules, t, {}, "/work").verdict, "allow", t)
})

test("buildArgs: flags, --from, and the request", () => {
  assert.deepEqual(buildArgs("add a --json flag"), { request: "add a --json flag" })
  assert.deepEqual(buildArgs("--research  add x"), { request: "add x", research: true })
  assert.deepEqual(buildArgs("--no-research add x"), { request: "add x", research: false })
  assert.deepEqual(buildArgs("--from json-flag"), { from: "json-flag" })
  assert.ok("error" in buildArgs(""))
  assert.ok("error" in buildArgs("--from"))
  assert.ok("error" in buildArgs("--from a b"))
  assert.ok("error" in buildArgs("--research --no-research x"))
})

test("modePrompt: the build's stages, research as decided, and research alone", () => {
  const p = (s: Parameters<typeof modePrompt>[0]) => modePrompt(s)
  const build = p({ path: ".pi/plans/x.md", mode: "build" })
  for (const s of ["1. Intake", "no recommended option", "2. Research", "Decide whether research runs", ".pi/plans/x.research.md", "3. Approaches", "4. Acceptance", "acceptance_check", "5. Plan", "/plan review"]) assert.ok(build.includes(s), s)
  assert.match(p({ path: ".pi/plans/x.md", mode: "build", research: true }), /Research runs: the user asked for it/)
  assert.match(p({ path: ".pi/plans/x.md", mode: "build", research: false }), /Skip research: the user said so/)
  const from = p({ path: ".pi/plans/x.md", mode: "build", from: true })
  assert.ok(!from.includes("1. Intake") && from.includes("Read .pi/plans/x.research.md") && from.includes("3. Approaches"))
  const research = p({ path: ".pi/plans/x.md", mode: "research" })
  assert.ok(research.includes("Write .pi/plans/x.research.md") && research.includes("/build --from x") && !research.includes("Acceptance"))
  assert.equal(p({ path: ".pi/plans/x.md" }), "")
})

test("acceptanceReport: every command must fail now", () => {
  const items = parsePlan("# T\n## Acceptance\n- a1: `false` exits 0\n- a2: `true` exits 0\n- a3: manual: look\n- a4: deferred: later\n").acceptance
  const r = acceptanceReport(items, { a1: { code: 1, output: "no" }, a2: { code: 0, output: "" } })
  assert.match(r, /a1: fails \(exit 1\), as it must/)
  assert.match(r, /a2: passes on the current tree: it does not measure the change\. Rewrite it or drop it, then check again/)
  assert.match(r, /a3: manual, not run/)
  assert.ok(!r.includes("a4"))
  assert.match(acceptanceReport([], {}), /No acceptance items/)
})

test("scout: a read-only agent on the small role", () => {
  assert.deepEqual([SCOUT.role, SCOUT.tools, SCOUT.allowedAgents], ["small", ["read", "grep", "find", "ls"], []])
})

test("scout results: text, failures, and the output cap", () => {
  assert.equal(clip("abc", 5), "abc")
  assert.match(clip("abcdef", 3), /^abc\n\[cut: 3 more/)
  const out = formatScouts(["q1", "q2", "q3", "q4"], [
    { status: "done", result: "found it\n" },
    { status: "failed", error: "boom" },
    { status: "stopped", error: "time limit" },
    { status: "done", result: "" },
  ])
  assert.match(out, /## Scout 1: q1\nfound it$/m)
  assert.match(out, /## Scout 2: q2\nfailed: boom/)
  assert.match(out, /## Scout 3: q3\nfailed: time limit/)
  assert.match(out, /## Scout 4: q4\n\(no output\)/)
})
