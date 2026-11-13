import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePlan } from "../extensions/tasks/plan.ts"
import {
  type Red, type RunPlan, type RunTask, answer, childPrompt, compile, filesOutside, finishCommand, nextBatch,
  overlap, redFailure, roleFor, safeId, start, testNames, validate,
} from "../extensions/tasks/run.ts"
import { type IO, runPlan } from "../extensions/tasks/runner.ts"

const task = (id: string, o: Partial<RunTask> = {}): RunTask => ({
  id, title: `t${id}`, deps: [], files: [`${id}.txt`], tests: [], role: "small", mode: "direct: x",
  spec: "ok", verify: `v${id}`, covers: [], status: "pending", ...o,
})
const plan = (...tasks: RunTask[]): RunPlan => ({ slug: "p", title: "P", goal: "g", decisions: "- d", acceptance: [], status: "running", tasks })

test("overlap: literals, globs, and the conservative case", () => {
  assert.equal(overlap("src/a.rs", "src/a.rs"), true)
  assert.equal(overlap("src/a.rs", "src/*.rs"), true)
  assert.equal(overlap("src/*.rs", "src/b.ts"), false)
  assert.equal(overlap("src/*", "src/a/b.rs"), true)
  assert.equal(overlap("src/*.rs", "src/*.ts"), false)
  assert.equal(overlap("src/*.rs", "tests/*.rs"), false)
  assert.equal(overlap("src/*", "src/*.rs"), true)
})

test("validate: overlapping files must be ordered by deps", () => {
  const a = task("1", { files: ["src/a.rs"] })
  const b = task("2", { files: ["src/*.rs"] })
  const [e] = validate([a, b])
  assert.match(e, /tasks 1 and 2 can run side by side but both touch src\/a\.rs and src\/\*\.rs/)
  assert.deepEqual(validate([a, { ...b, deps: ["1"] }]), [])
  // ordered through a third task
  assert.deepEqual(validate([a, task("3", { deps: ["1"] }), { ...b, deps: ["3"] }]), [])
})

test("validate: cycles and git-name clashes", () => {
  assert.match(validate([task("1", { deps: ["2"] }), task("2", { deps: ["1"] })])[0], /form a cycle/)
  assert.match(validate([task("a/b"), task("a_b")])[0], /share the git name a_b/)
  assert.equal(safeId("3.1"), "3.1")
  assert.equal(safeId("a b/c"), "a_b_c")
})

const TEXT = `---
status: approved
---
# Pkg

## Goal
Install things.

## Decisions
- use dnf

## Tasks
### 1 first
- files: a.txt
- role: small
- mode: direct: x
- spec: a
- verify: true
### 2 second
- deps: 1
- files: a.txt
- role: large
- mode: direct: x
- spec: b
- verify: true

## Finish
\`make test\`
`

test("compile: the plan becomes the task tree", () => {
  const c = compile(parsePlan(TEXT), TEXT, "pkg")
  assert.deepEqual(c.errors, [])
  assert.equal(c.run?.goal, "Install things.")
  assert.equal(c.run?.decisions, "- use dnf")
  assert.equal(c.run?.finish, "make test")
  assert.deepEqual(c.run?.tasks.map((t) => [t.id, t.status, t.deps]), [["1", "pending", []], ["2", "pending", ["1"]]])
  assert.equal(finishCommand("# x\n"), undefined)
  const bad = TEXT.replace("- deps: 1\n", "")
  assert.match(compile(parsePlan(bad), bad, "pkg").errors[0], /both touch a\.txt/)
})

test("batches: ready tasks only, up to the limit", () => {
  const r = plan(task("1"), task("2"), task("3", { deps: ["1"] }), task("4"))
  assert.deepEqual(nextBatch(r, 2).map((t) => t.id), ["1", "2"])
  assert.deepEqual(nextBatch(r, 9).map((t) => t.id), ["1", "2", "4"])
  r.tasks[0].status = "done"
  r.tasks[1].status = "running"
  assert.deepEqual(nextBatch(r, 9).map((t) => t.id), ["3", "4"])
})

test("start: interrupted and failed tasks go back to pending", () => {
  const r = plan(task("1", { status: "running" }), task("2", { status: "done" }), task("3", { status: "failed", attempts: 3 }), task("4", { status: "review" }))
  assert.deepEqual(start(r).map((t) => t.id), ["1", "3", "4"])
  assert.deepEqual(r.tasks.map((t) => t.status), ["pending", "done", "pending", "pending"])
  assert.equal(r.tasks[2].attempts, undefined)
})

test("role: two failures on the task's role, then large", () => {
  assert.deepEqual([0, 1, 2].map((attempts) => roleFor(task("1", { attempts }))), ["small", "small", "large"])
})

test("files check", () => {
  assert.deepEqual(filesOutside(["src/a.rs", "README.md", "tests/x.rs"], ["src/*.rs", "tests/x.rs"]), ["README.md"])
})

test("child prompt", () => {
  const t = task("1", { files: ["a.rs", "b/*.rs"], verify: "cargo test", notes: "it broke" })
  const p = childPrompt(plan(t), t)
  for (const s of ["Goal: g", "- d", "Task 1: t1", "a.rs, b/*.rs", "cargo test", "it broke", "request_files"]) assert.ok(p.includes(s), s)
  assert.ok(!p.includes("Red:"))
  const tdd = childPrompt(plan(t), { ...t, mode: "tdd", tests: ["b/*.rs"] })
  for (const s of ["Red:", "Green:", "Refactor:", "only b/*.rs"]) assert.ok(tdd.includes(s), s)
  assert.ok(childPrompt(plan(t), { ...t, answer: "granted: x" }).includes("The answer: granted: x"))
})

test("testNames: Rust and Python functions, JS test and it strings", () => {
  const added = [
    "#[test]", "fn json_flag() {", "    fn helper() {}", "def test_empty(tmp):", "def other():",
    `test("prints one object", () => {`, "it('handles []', async () => {", "test (`x`)", "fn json_flag() {",
  ].join("\n")
  assert.deepEqual(testNames(added), ["json_flag", "helper", "test_empty", "prints one object", "handles []", "x"])
})

test("redFailure: only tests, verify fails, and fails in what the commit added", () => {
  const t = task("1", { mode: "tdd", tests: ["tests/*.rs"], verify: "cargo test" })
  const red = { files: ["tests/a.rs"], added: "fn json_flag() {", code: 101, output: "test json_flag ... FAILED" }
  assert.equal(redFailure(t, red), undefined)
  assert.equal(redFailure(t, { ...red, output: "error[E0425]: cannot find function `export`\n --> tests/a.rs:4:5" }), undefined, "a build error in the new tests")
  assert.match(redFailure(t, undefined) ?? "", /commits twice at least/)
  assert.match(redFailure(t, { ...red, files: ["tests/a.rs", "src/a.rs"] }) ?? "", /must touch only the tests, tests\/\*\.rs; it touches src\/a\.rs/)
  assert.match(redFailure(t, { ...red, code: 0 }) ?? "", /passes: the new tests must fail/)
  assert.match(redFailure(t, { ...red, added: "let x = 1" }) ?? "", /adds no test/)
  assert.match(redFailure(t, { ...red, output: "error: src/lib.rs:3 mismatched types" }) ?? "", /names none of the new tests \(json_flag\) nor tests\/a\.rs/)
})

test("answer: granted unless a task that may run alongside touches the files", () => {
  const r = plan(task("1"), task("2", { files: ["b/*.rs"] }), task("3", { deps: ["1"], files: ["c.rs"] }), task("4", { status: "done", files: ["d.rs"] }))
  const t = r.tasks[0]
  assert.match(answer(r, t, { files: ["b/x.rs"], reason: "r" }), /refused: b\/x\.rs belongs to task 2/)
  assert.match(answer(r, t, { files: ["c.rs", "d.rs", "e.rs"], reason: "r" }), /^granted/) // 3 waits for 1, 4 is done
  assert.deepEqual(t.files, ["1.txt", "c.rs", "d.rs", "e.rs"])
  assert.deepEqual(t.granted, [{ files: ["c.rs", "d.rs", "e.rs"], reason: "r" }])
  assert.match(answer(r, t, { files: ["../x"], reason: "r" }), /refused: give paths relative/)
  assert.match(answer(r, t, { files: ["f.rs"], reason: "r" }), /refused: this task already asked 3 times/)
})

// A fake IO: `script` says what each attempt of each task did; `requests` what each child asked for.
type Attempt = { files?: string[]; uncommitted?: string[]; verify?: number; red?: Red }
function fake(script: Record<string, Attempt[]>, landError: Record<string, string> = {}, requests: Record<string, string[][]> = {}) {
  const calls: string[] = []
  const saved: string[] = []
  const used: Record<string, number> = {}
  const current = (t: RunTask) => script[t.id][used[t.id] - 1]
  const io: IO = {
    save: (r) => saved.push(r.tasks.map((t) => t.status[0]).join("")),
    log: () => {},
    prepare: async (t) => void calls.push(`prepare ${t.id}`),
    child: async (t, role) => {
      used[t.id] = (used[t.id] ?? 0) + 1
      calls.push(`child ${t.id} ${role}`)
      return { code: 0, output: "" }
    },
    request: async (t) => {
      const files = requests[t.id]?.shift()
      return files && { files, reason: "needed" }
    },
    changed: async (t) => ({ files: current(t).files ?? t.files, uncommitted: current(t).uncommitted ?? [] }),
    red: async (t) => (calls.push(`red ${t.id}`), current(t).red),
    verify: async (t) => ({ code: current(t).verify ?? 0, output: `output of ${t.id}` }),
    land: async (t) => (calls.push(`land ${t.id}`), landError[t.id]),
    remove: async (t) => void calls.push(`remove ${t.id}`),
    finish: async (c) => (calls.push(`finish ${c}`), { code: 0, output: "" }),
  }
  return { io, calls, saved }
}
const ok: Attempt[] = [{}]

test("run: two in parallel, then the one that depends on them, landed in order", async () => {
  const r = plan(task("1"), task("2"), task("3", { deps: ["1"] }))
  r.finish = "make test"
  const { io, calls } = fake({ 1: ok, 2: ok, 3: ok })
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, true)
  assert.deepEqual(calls, [
    "prepare 1", "prepare 2", "child 1 small", "child 2 small", "land 1", "remove 1", "land 2", "remove 2",
    "prepare 3", "child 3 small", "land 3", "remove 3", "finish make test",
  ])
  assert.deepEqual(r.tasks.map((t) => t.status), ["done", "done", "done"])
  assert.equal(r.status, "done")
})

test("run: a diff outside files is refused, retried with notes, escalated, then failed", async () => {
  const bad: Attempt = { files: ["1.txt", "other.txt"] }
  const r = plan(task("1"), task("2"))
  const { io, calls } = fake({ 1: [bad, bad, bad], 2: ok })
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, false)
  assert.deepEqual(calls.filter((c) => c.startsWith("child 1")), ["child 1 small", "child 1 small", "child 1 large"])
  assert.equal(r.tasks[0].status, "failed")
  assert.match(r.tasks[0].notes ?? "", /outside the task's files: other\.txt/)
  assert.equal(r.tasks[1].status, "done") // the task that passed still landed
  assert.ok(!calls.includes("land 1"))
  assert.equal(r.status, "running")
  assert.match(res.message, /worktree \.pi\/worktrees\/1 kept/)
})

test("run: failing verify twice escalates to the large role, which can pass", async () => {
  const r = plan(task("1"))
  const { io, calls } = fake({ 1: [{ verify: 1 }, { verify: 2 }, {}] })
  const res = await runPlan(r, 1, io)
  assert.equal(res.ok, true)
  assert.deepEqual(calls.filter((c) => c.startsWith("child")), ["child 1 small", "child 1 small", "child 1 large"])
  assert.equal(r.tasks[0].attempts, 2)
  assert.equal(r.tasks[0].notes, undefined)
})

test("run: a tdd task is checked at its red commit; a direct one is not", async () => {
  const red: Red = { files: ["t/1.txt"], added: "fn one() {", code: 1, output: "one FAILED" }
  const r = plan(task("1", { mode: "tdd", tests: ["t/*"], files: ["1.txt", "t/*"] }), task("2"))
  const { io, calls } = fake({ 1: [{ red: { ...red, code: 0 } }, { red }], 2: ok })
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, true)
  assert.deepEqual(calls.filter((c) => c.startsWith("red")), ["red 1", "red 1"])
  assert.equal(r.tasks[0].attempts, 1)
})

test("run: uncommitted work and a missing commit are failures with notes", async () => {
  const r = plan(task("1"))
  const { io } = fake({ 1: [{ uncommitted: ["x.txt"] }, { files: [] }, { files: [] }] })
  await runPlan(r, 1, io)
  assert.equal(r.tasks[0].status, "failed")
  assert.match(r.tasks[0].notes ?? "", /No commit was made/)
})

test("run: a failed landing stops the run; failed finish keeps the plan open", async () => {
  const r = plan(task("1"), task("2", { deps: ["1"] }))
  const a = await runPlan(r, 1, fake({ 1: ok, 2: ok }, { 1: "conflict" }).io)
  assert.equal(a.ok, false)
  assert.deepEqual(r.tasks.map((t) => t.status), ["failed", "pending"])
  assert.match(r.tasks[0].notes ?? "", /Landing failed: conflict/)
})

// Finish: `codes` holds what each command exits with, one per run of it; 0 when none is left.
function finishing(codes: Record<string, number[]>, fix: Attempt[] = ok) {
  const r = plan(task("1", { files: ["src/*"] }), task("2"))
  r.finish = "make test"
  r.acceptance = [
    { id: "a1", kind: "command", text: "./a1" },
    { id: "a2", kind: "manual", text: "the help names it" },
    { id: "a3", kind: "deferred", text: "later" },
  ]
  const fk = fake({ 1: ok, 2: ok, "!fix": fix })
  fk.io.finish = async (c) => (fk.calls.push(`finish ${c}`), { code: codes[c]?.shift() ?? 0, output: `out of ${c}` })
  const prompts: string[] = []
  const child = fk.io.child
  fk.io.child = async (t, role, p) => (prompts.push(p), child(t, role, p))
  return { r, ...fk, prompts }
}

test("finish: the finish command and every acceptance command; manual items are listed", async () => {
  const { r, io, calls } = finishing({})
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, true)
  assert.deepEqual(calls.filter((c) => c.startsWith("finish")), ["finish make test", "finish ./a1"])
  assert.match(res.message, /Check by hand:\n- a2: the help names it/)
  assert.equal(r.status, "done")
})

test("finish: one remediation gets only the failures, lands, and both run again", async () => {
  const { r, io, calls, prompts } = finishing({ "./a1": [1] })
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, true)
  const fix = calls.slice(calls.indexOf("finish ./a1") + 1)
  assert.deepEqual(fix, ["prepare !fix", "child !fix large", "land !fix", "remove !fix", "finish make test", "finish ./a1"])
  const p = prompts.at(-1) ?? ""
  assert.match(p, /\.\/a1 \(exit 1\):\nout of \.\/a1/)
  assert.ok(!p.includes("make test") && !p.includes("Goal:"), "only the failing commands")
  assert.equal(r.remediated, true)
})

test("finish: a second failure stops for the user, and the fix is not tried again", async () => {
  const { r, io, calls } = finishing({ "make test": [2, 2, 2] })
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, false)
  assert.equal(r.status, "running")
  assert.match(res.message, /still fail after one fix[\s\S]*make test \(exit 2\)/)
  const again = await runPlan(r, 2, io)
  assert.equal(again.ok, false)
  assert.equal(calls.filter((c) => c.startsWith("child !fix")).length, 1)
  assert.match(again.message, /make test \(exit 2\)/)
})

test("finish: a fix that fails its check is not landed", async () => {
  const { r, io, calls } = finishing({ "./a1": [1, 1] }, [{ files: ["elsewhere.txt"] }])
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, false)
  assert.ok(!calls.includes("land !fix"))
  assert.match(res.message, /outside the task's files: elsewhere\.txt/)
  assert.match(res.message, /\.pi\/worktrees\/_fix kept/)
})

test("run: a request is answered and the child goes on without a reset", async () => {
  const r = plan(task("1"), task("2", { files: ["2.txt", "shared.txt"] }))
  const { io, calls } = fake({ 1: [{}, {}, { files: ["1.txt", "x.txt"] }], 2: ok }, {}, { 1: [["x.txt"], ["shared.txt"]] }) // one entry per child run
  const res = await runPlan(r, 2, io)
  assert.equal(res.ok, true)
  assert.deepEqual(calls.filter((c) => c.includes(" 1")), ["prepare 1", "child 1 small", "child 1 small", "child 1 small", "land 1", "remove 1"])
  assert.deepEqual(r.tasks[0].files, ["1.txt", "x.txt"]) // shared.txt was refused: task 2 runs alongside
  assert.equal(r.tasks[0].answer, undefined)
})

test("run: a stop leaves tasks running, lands those that passed, and starts nothing new", async () => {
  const c = new AbortController()
  const r = plan(task("1"), task("2"), task("3", { deps: ["1"] }))
  const { io, calls } = fake({ 1: ok, 2: ok, 3: ok })
  const child = io.child
  io.child = async (t, role, p) => {
    const o = await child(t, role, p)
    if (t.id === "2") await new Promise((done) => setTimeout(done, 20)), c.abort() // after task 1 passed
    return { ...o, code: t.id === "2" ? null : 0 }
  }
  const res = await runPlan(r, 2, io, c.signal)
  assert.equal(res.ok, false)
  assert.match(res.message, /^Stopped\. \/tasks run resumes/)
  assert.deepEqual(r.tasks.map((t) => t.status), ["done", "running", "pending"])
  assert.ok(!calls.includes("child 3 small"))
})

test("run: a stop that kills verify is no failed attempt", async () => {
  const c = new AbortController()
  const r = plan(task("1"))
  const { io } = fake({ 1: ok })
  io.verify = async () => (c.abort(), { code: null, output: "" })
  await runPlan(r, 1, io, c.signal)
  assert.equal(r.tasks[0].status, "running")
  assert.equal(r.tasks[0].attempts, undefined)
  assert.equal(r.tasks[0].notes, undefined)
})

test("run: statuses are saved while the run goes", async () => {
  const r = plan(task("1"))
  const { io, saved } = fake({ 1: ok })
  await runPlan(r, 1, io)
  assert.deepEqual(saved, ["r", "r", "d", "d"]) // running, review, done, plan done
})
