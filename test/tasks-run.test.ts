import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePlan } from "../home/.pi/agent/extensions/tasks/plan.ts"
import {
  type RunPlan, type RunTask, answer, childArgs, childEnv, childPrompt, compile, filesOutside, finishCommand, nextBatch,
  overlap, safeId, start, tierFor, validate,
} from "../home/.pi/agent/extensions/tasks/run.ts"
import { type IO, runPlan } from "../home/.pi/agent/extensions/tasks/runner.ts"

const task = (id: string, o: Partial<RunTask> = {}): RunTask => ({
  id, title: `t${id}`, deps: [], files: [`${id}.txt`], tier: "small", verify: `v${id}`, accept: "ok", status: "pending", ...o,
})
const plan = (...tasks: RunTask[]): RunPlan => ({ slug: "p", title: "P", goal: "g", decisions: "- d", status: "running", tasks })

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
- tier: small
- verify: true
- accept: a
### 2 second
- deps: 1
- files: a.txt
- tier: large
- verify: true
- accept: b

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

test("tier: two failures on the task's tier, then large", () => {
  assert.deepEqual([0, 1, 2].map((attempts) => tierFor(task("1", { attempts }))), ["small", "small", "large"])
})

test("files check", () => {
  assert.deepEqual(filesOutside(["src/a.rs", "README.md", "tests/x.rs"], ["src/*.rs", "tests/x.rs"]), ["README.md"])
})

test("child arguments, environment, prompt", () => {
  const t = task("1", { files: ["a.rs", "b/*.rs"], verify: "cargo test", notes: "it broke" })
  assert.deepEqual(childArgs({ provider: "p", id: "m" }, "do it"), ["-p", "--no-session", "--no-mcp", "-na", "--provider", "p", "--model", "m", "do it"])
  const env = childEnv(t, { PATH: "/bin" }, true, "/w/.pi/worktrees/1.request.json")
  assert.equal(env.OTHALA_TASK_FILES, "a.rs:b/*.rs")
  assert.equal(env.OTHALA_TASK_REQUEST, "/w/.pi/worktrees/1.request.json")
  assert.equal(env.OTHALA_TASK_VERIFY, "cargo test")
  assert.equal(env.RUSTC_WRAPPER, "sccache")
  assert.equal(childEnv(t, {}, false, "r").RUSTC_WRAPPER, undefined)
  const p = childPrompt(plan(t), t)
  for (const s of ["Goal: g", "- d", "Task 1: t1", "a.rs, b/*.rs", "cargo test", "it broke", "request_files"]) assert.ok(p.includes(s), s)
  assert.ok(childPrompt(plan(t), { ...t, answer: "granted: x" }).includes("The answer: granted: x"))
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
type Attempt = { files?: string[]; uncommitted?: string[]; verify?: number }
function fake(script: Record<string, Attempt[]>, landError: Record<string, string> = {}, requests: Record<string, string[][]> = {}) {
  const calls: string[] = []
  const saved: string[] = []
  const used: Record<string, number> = {}
  const current = (t: RunTask) => script[t.id][used[t.id] - 1]
  const io: IO = {
    save: (r) => saved.push(r.tasks.map((t) => t.status[0]).join("")),
    log: () => {},
    prepare: async (t) => void calls.push(`prepare ${t.id}`),
    child: async (t, tier) => {
      used[t.id] = (used[t.id] ?? 0) + 1
      calls.push(`child ${t.id} ${tier}`)
      return { code: 0, output: "" }
    },
    request: async (t) => {
      const files = requests[t.id]?.shift()
      return files && { files, reason: "needed" }
    },
    changed: async (t) => ({ files: current(t).files ?? t.files, uncommitted: current(t).uncommitted ?? [] }),
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

test("run: failing verify twice escalates to the large tier, which can pass", async () => {
  const r = plan(task("1"))
  const { io, calls } = fake({ 1: [{ verify: 1 }, { verify: 2 }, {}] })
  const res = await runPlan(r, 1, io)
  assert.equal(res.ok, true)
  assert.deepEqual(calls.filter((c) => c.startsWith("child")), ["child 1 small", "child 1 small", "child 1 large"])
  assert.equal(r.tasks[0].attempts, 2)
  assert.equal(r.tasks[0].notes, undefined)
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

  const f = plan(task("1"))
  f.finish = "make test"
  const fk = fake({ 1: ok })
  fk.io.finish = async () => ({ code: 2, output: "boom" })
  const b = await runPlan(f, 1, fk.io)
  assert.equal(b.ok, false)
  assert.equal(f.status, "running")
  assert.match(b.message, /make test` failed \(exit 2\)/)
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
  io.child = async (t, tier, p) => {
    const o = await child(t, tier, p)
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
