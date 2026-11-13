// Pure logic of the task runner (workflow steps 3 to 7): no Pi imports, so node --test runs it.
// The git and process calls live in git.ts; runner.ts drives them through an injected IO.

import { glob } from "../guardrails/rules.ts"
import type { Finding } from "./findings.ts"
import { type Acceptance, type Plan, type Task, sectionOf } from "./plan.ts"
import type { Role } from "../lib/profiles.ts"

export type Status = "pending" | "running" | "review" | "done" | "failed"
export type Request = { files: string[]; reason: string } // a child asking for more files
export type RunTask = Task & {
  status: Status
  attempts?: number
  notes?: string // why the last attempt failed
  answer?: string // the runner's answer to the child's last request
  requests?: number
  granted?: Request[]
}
export type RunPlan = {
  slug: string
  title: string
  goal: string
  decisions: string
  finish?: string // command run once every task has landed
  acceptance: Acceptance[]
  base?: string // HEAD when the run first started: the build's diff starts there
  remediated?: boolean // the one fix for a failing finish was made
  simplified?: boolean
  reviewed?: boolean
  status: "running" | "done"
  tasks: RunTask[]
}

export const MAX_ATTEMPTS = 3
export const MAX_REQUESTS = 3

// "## Finish": the first line, as a command (backticks around it are dropped).
export function finishCommand(text: string): string | undefined {
  const line = sectionOf(text, "Finish").split("\n")[0]?.trim().replace(/^`+|`+$/g, "")
  return line || undefined
}

// Git ref and directory name of a task: ids like "2.1" are fine, anything odd becomes "_".
export const safeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_")

// Two globs may match the same path. Exact for a literal path, conservative for two patterns:
// they overlap unless their literal heads or their literal tails differ.
export function overlap(a: string, b: string): boolean {
  const wild = (s: string) => /[*?]/.test(s)
  if (!wild(a)) return glob(b, a)
  if (!wild(b)) return glob(a, b)
  const head = (s: string) => s.slice(0, s.search(/[*?]/))
  const tail = (s: string) => s.slice(Math.max(s.lastIndexOf("*"), s.lastIndexOf("?")) + 1)
  const related = (x: string, y: string) => x.startsWith(y) || y.startsWith(x)
  const ends = (x: string, y: string) => x.endsWith(y) || y.endsWith(x)
  return related(head(a), head(b)) && ends(tail(a), tail(b))
}

// Every task a task depends on, directly or not. A cycle is reported instead.
export function ancestors(tasks: Task[]): { all: Map<string, Set<string>>; cycle?: string } {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const all = new Map<string, Set<string>>()
  const visiting = new Set<string>()
  let cycle: string | undefined
  const walk = (id: string): Set<string> => {
    const known = all.get(id)
    if (known) return known
    if (visiting.has(id)) return (cycle ??= id), new Set()
    visiting.add(id)
    const out = new Set<string>()
    for (const d of byId.get(id)?.deps ?? []) (out.add(d), walk(d).forEach((x) => out.add(x)))
    visiting.delete(id)
    all.set(id, out)
    return out
  }
  tasks.forEach((t) => walk(t.id))
  return { all, cycle }
}

// Dependencies exist (parsePlan checked), have no cycle, and tasks that may run side by
// side (not ordered by deps) touch disjoint files.
export function validate(tasks: Task[]): string[] {
  const errors: string[] = []
  const safe = new Map<string, string>()
  for (const t of tasks) {
    const other = safe.get(safeId(t.id))
    if (other) errors.push(`tasks ${other} and ${t.id} share the git name ${safeId(t.id)}`)
    safe.set(safeId(t.id), t.id)
  }
  const { all, cycle } = ancestors(tasks)
  if (cycle) return [...errors, `the dependencies of task ${cycle} form a cycle`]
  tasks.forEach((a, i) => {
    for (const b of tasks.slice(i + 1)) {
      if (all.get(a.id)?.has(b.id) || all.get(b.id)?.has(a.id)) continue
      for (const x of a.files) {
        const y = b.files.find((f) => overlap(x, f))
        if (y) errors.push(`tasks ${a.id} and ${b.id} can run side by side but both touch ${x === y ? x : `${x} and ${y}`}; make one depend on the other`)
      }
    }
  })
  return errors
}

export function compile(plan: Plan, text: string, slug: string): { run?: RunPlan; errors: string[] } {
  const errors = validate(plan.tasks)
  if (errors.length) return { errors }
  const run: RunPlan = {
    slug,
    title: plan.title,
    goal: sectionOf(text, "Goal"),
    decisions: sectionOf(text, "Decisions"),
    ...(finishCommand(text) ? { finish: finishCommand(text) } : {}),
    acceptance: plan.acceptance,
    status: "running",
    tasks: plan.tasks.map((t) => ({ ...t, status: "pending" as const })),
  }
  return { run, errors }
}

// Resume after an interruption, or after a failure the user dealt with. Returns the tasks
// put back to pending; prepare() resets their worktrees. Files granted earlier stay granted.
export function start(run: RunPlan): RunTask[] {
  const back = run.tasks.filter((t) => t.status === "running" || t.status === "review" || t.status === "failed")
  for (const t of back) {
    delete t.attempts
    delete t.requests
    delete t.answer
    t.status = "pending"
  }
  return back
}

// Ready tasks are unordered with one another, so compile() already made their files disjoint.
export function nextBatch(run: RunPlan, max: number): RunTask[] {
  const done = new Set(run.tasks.filter((t) => t.status === "done").map((t) => t.id))
  return run.tasks.filter((t) => t.status === "pending" && t.deps.every((d) => done.has(d))).slice(0, max)
}

// Two failed attempts on the task's own role, then the large one.
export const roleFor = (t: RunTask): Role => ((t.attempts ?? 0) >= 2 ? "large" : t.role)

// A request is granted when no task that may run at the same time touches the files, so the
// tasks of a batch stay disjoint; the parent decides, and nobody is asked.
export function answer(run: RunPlan, t: RunTask, req: Request): string {
  t.requests = (t.requests ?? 0) + 1
  if (t.requests > MAX_REQUESTS) return `refused: this task already asked ${MAX_REQUESTS} times; finish within its files, or make no commit and say why`
  const bad = req.files.filter((f) => !f || f.startsWith("/") || f.split("/").includes(".."))
  if (!req.files.length || bad.length) return `refused: give paths relative to the project, without ..${bad.length ? ` (${bad.join(", ")})` : ""}`
  const { all } = ancestors(run.tasks)
  const ordered = (o: RunTask) => all.get(t.id)?.has(o.id) || all.get(o.id)?.has(t.id)
  for (const o of run.tasks) {
    if (o.id === t.id || o.status === "done" || ordered(o)) continue
    const f = req.files.find((x) => o.files.some((y) => overlap(x, y)))
    if (f) return `refused: ${f} belongs to task ${o.id}, which may run at the same time; do without it, or make no commit and say why`
  }
  t.files.push(...req.files.filter((f) => !t.files.includes(f)))
  t.granted = [...(t.granted ?? []), req]
  return `granted: you may now change ${req.files.join(", ")}`
}

export const filesOutside = (changed: string[], globs: string[]) => changed.filter((f) => !globs.some((g) => glob(g, f)))

// A tdd task's first commit, as the runner found it: its files, its added lines, and verify run there.
export type Red = { files: string[]; added: string; code: number | null; output: string }

// Test names in added lines: Rust `fn`, pytest `def test_`, JS `test("...")` and `it("...")`.
export function testNames(added: string): string[] {
  const all = added.matchAll(/\bfn\s+(\w+)|\bdef\s+(test_\w*)|\b(?:test|it)\s*\(\s*(["'`])(.+?)\3/g)
  return [...new Set([...all].map((m) => m[1] ?? m[2] ?? m[4]))]
}

// TDD's red step. The failure must be in what the red commit added: output naming a new test, or one of
// its files, as a compiler does for a test calling a function not written yet; not a build error elsewhere.
export function redFailure(t: RunTask, red: Red | undefined): string | undefined {
  if (!red) return "A tdd task commits twice at least: its tests alone first (red), then the change (green)."
  const outside = filesOutside(red.files, t.tests)
  if (outside.length) return `The first commit (red) must touch only the tests, ${t.tests.join(", ")}; it touches ${outside.join(", ")}.`
  if (red.code === 0) return `At the first commit (red), \`${t.verify}\` passes: the new tests must fail before the change.`
  const names = testNames(red.added)
  if (!names.length) return "The first commit (red) adds no test by a name the runner can find: `fn`, `def test_`, `test(\"...\"`, `it(\"...\"`."
  if ([...names, ...red.files].some((n) => red.output.includes(n))) return undefined
  return `At the first commit (red), \`${t.verify}\` fails, but its output names none of the new tests (${names.join(", ")}) nor ${red.files.join(", ")}: ` +
    `it must fail in them, not on a build error elsewhere.\n${tail(red.output, 2000)}`
}

export function childPrompt(run: RunPlan, t: RunTask): string {
  return [
    `You are one task of a larger plan, working alone in your own git worktree. Do this task and nothing else.`,
    `Plan: ${run.title}\nGoal: ${run.goal}${run.decisions ? `\nDecisions:\n${run.decisions}` : ""}`,
    `Task ${t.id}: ${t.title}\nSpec: ${t.spec}\nMode: ${t.mode}\nFiles you may change: ${t.files.join(", ")}${t.tests.length ? `\nTests: ${t.tests.join(", ")}` : ""}`,
    verifyLine(t),
    "If the task cannot be done without changing a file outside these, call request_files with the paths and the reason, " +
      "then end your turn; you are started again with the answer, and your changes so far stay in the worktree.",
    t.mode === "tdd" ? tddSteps(t) : "Steps: make the change; run the verify command until it passes; then commit.",
    COMMIT,
    ...(t.notes ? [`Your previous attempt failed:\n${t.notes}\nFix that.`] : []),
    ...(t.answer ? [`You asked for more files. The answer: ${t.answer}. Your changes so far are still in the worktree; go on from there.`] : []),
  ].join("\n\n")
}

const verifyLine = (t: RunTask) =>
  `Verify command: ${t.verify}\nRun it exactly as written, with no pipe, redirect or other command added: guardrails refuse any other form.`

const COMMIT =
  "To commit, `git add` the files (new files included, by path) and `git commit` with a short imperative message, as a command line " +
  "of their own: `git add <paths> && git commit -m <message>`, nothing else chained, or guardrails refuse it. Nothing may be left " +
  "uncommitted. The message never mentions Claude, Pi or AI and has no Co-Authored-By line. Do not push or switch branches."

// A finish or acceptance command that did not exit 0.
export type Failure = { command: string; code: number | null; output: string }

export const showFailures = (fs: Failure[]) => fs.map((f) => `${f.command} (exit ${f.code}):\n${tail(f.output, 2000)}`).join("\n\n")

// The finish command and the acceptance commands, in that order.
export const finishCommands = (run: RunPlan) => [...(run.finish ? [run.finish] : []), ...run.acceptance.filter((a) => a.kind === "command").map((a) => a.text)]

// A job after the tasks (the remediation, simplify, the review's minor fixes): one agent over the
// plan's files, checked and landed as a task is. Its id is no plan task's: "!" becomes "_" in git names.
export function job(run: RunPlan, id: string, title: string, verify: string): RunTask {
  return {
    id,
    title,
    deps: [],
    files: [...new Set(run.tasks.flatMap((t) => t.files))],
    tests: [],
    role: "large",
    mode: `direct: ${title}`,
    spec: title,
    verify,
    covers: [],
    status: "running",
  }
}

const jobPrompt = (t: RunTask, ...parts: string[]) => [...parts, `Files you may change: ${t.files.join(", ")}`, verifyLine(t), COMMIT].join("\n\n")

// Only the failures: the fixing agent does not see the plan.
export const fixPrompt = (fix: RunTask, failures: Failure[]) =>
  jobPrompt(
    fix,
    "Every task of a plan has landed in this git worktree, but these commands fail:",
    showFailures(failures),
    "Make the one smallest fix that makes them pass, and nothing else: no refactor, no other change.",
  )

export const simplifyPrompt = (t: RunTask, rules: string, diff: string) =>
  jobPrompt(
    t,
    "A plan was built in this git worktree; its diff is below. Cut what need not exist, by these rules:",
    rules,
    "Apply the cuts yourself, one at a time: after each, run the verify command, and undo the cut if it fails. " +
      "Change no behaviour. Commit every cut that stays in one commit at the end, or commit nothing when there is nothing to cut.",
    `\`\`\`diff\n${diff}\`\`\``,
  )

export const minorPrompt = (t: RunTask, findings: Finding[]) =>
  jobPrompt(
    t,
    "A review of the plan built in this git worktree found these minor problems:",
    findings.map((f) => `- ${f.path}:${f.line} ${f.text} (\`${f.quote}\`)`).join("\n"),
    "Fix each, minimally, with the verify command passing. One commit for all of them.",
  )

// A review finding the user chose to fix: a task of the plan, after the others not done yet, so
// two fixes of one file never run side by side.
export function findingTask(run: RunPlan, f: Finding): RunTask {
  let n = 1
  while (run.tasks.some((t) => t.id === `r${n}`)) n++
  return {
    id: `r${n}`,
    title: `${f.severity} at ${f.path}:${f.line}`,
    deps: run.tasks.filter((t) => t.status !== "done").map((t) => t.id),
    files: [f.path],
    tests: [],
    role: "large",
    mode: "direct: a review finding",
    spec: `${f.text} At ${f.path}:${f.line}: \`${f.quote}\``,
    verify: finishCommands(run).join(" && ") || "true",
    covers: [],
    status: "pending",
  }
}

const tddSteps = (t: RunTask) =>
  "Steps, test first:\n" +
  `1. Red: write the tests the spec describes, in only ${t.tests.join(", ")}. Run the verify command and see the new tests fail, ` +
  "in the tests themselves, not on a build error elsewhere. Commit only those paths.\n" +
  "2. Green: the smallest change that makes the verify command pass. Commit.\n" +
  "3. Refactor: simplify your own diff, the verify command still passing. Commit, or nothing when there is nothing to cut.\n" +
  "The runner checks each step from your commits, and squashes them into one when the task lands."

export const tail = (text: string, max: number) => (text.length <= max ? text : `[...]\n${text.slice(-max)}`)

export function summary(run: RunPlan): string {
  const lines = run.tasks.map((t) => {
    const tries = t.attempts ? `, ${t.attempts} failed attempt${t.attempts === 1 ? "" : "s"}` : ""
    return `- ${t.id} ${t.title}: ${t.status}${tries}`
  })
  return `${run.title} (${run.slug}): ${run.status}\n${lines.join("\n")}`
}
