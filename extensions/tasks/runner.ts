// The scheduler: steps 4 to 7 of the workflow over an injected IO, so node --test drives it
// with fakes. git.ts is the IO that runs git, the task agents and the verify commands.

import {
  MAX_ATTEMPTS, MAX_REQUESTS, type Failure, type Red, type Request, type RunPlan, type RunTask, answer, childPrompt, filesOutside, finishCommands,
  fixPrompt, job, minorPrompt, nextBatch, redFailure, safeId, roleFor, showFailures, simplifyPrompt, summary, tail,
} from "./run.ts"
import { type Finding, checkFindings, judgePrompt, parseFindings, reviewPrompt, showFinding, silentFiles } from "./findings.ts"
import { MAX_DIFF_CHARS, capDiff } from "../simplify/diff.ts"
import type { Role } from "../lib/profiles.ts"

export type Output = { code: number | null; output: string }
export type IO = {
  save(run: RunPlan): void
  log(message: string): void
  prepare(t: RunTask): Promise<void> // the task's worktree at the current HEAD, empty
  child(t: RunTask, role: Role, prompt: string): Promise<Output> // a task agent; code 0 when it ended well
  request(t: RunTask): Promise<Request | undefined> // what the agent asked for with request_files, taken once
  changed(t: RunTask): Promise<{ files: string[]; uncommitted: string[] }> // against the base commit
  red(t: RunTask): Promise<Red | undefined> // a tdd task's first commit, with verify run there; none with fewer than two commits
  verify(t: RunTask): Promise<Output>
  land(t: RunTask): Promise<string | undefined> // an error text, or nothing; all or nothing on HEAD
  remove(t: RunTask): Promise<void>
  finish(command: string): Promise<Output>
  // The review agent, read-only, in the task's worktree, or the project without one.
  review(t: RunTask | undefined, role: Role, prompt: string): Promise<Output>
  diff(t: RunTask | undefined, base?: string): Promise<string> // a task's commits, or the project's since base
  read(t: RunTask | undefined, path: string): string | undefined
  skill(name: string): string // a skill's text, for an agent that loads none
}

const capped = (diff: string) => {
  const { text, omitted } = capDiff(diff, MAX_DIFF_CHARS)
  return omitted.length ? `${text}\n(too large to show; read them with git diff: ${omitted.join(", ")})\n` : text
}

// The review agent's findings whose quotes are in the files.
async function findings(t: RunTask | undefined, role: Role, prompt: string, io: IO): Promise<Finding[]> {
  const out = await io.review(t, role, prompt)
  return checkFindings(parseFindings(out.output), (p) => io.read(t, p)).kept
}

// JUDGE: after the mechanical checks, a fresh review of the task's diff against its spec.
async function judge(run: RunPlan, t: RunTask, io: IO): Promise<string | undefined> {
  const bad = (await findings(t, "small", judgePrompt(run, t, capped(await io.diff(t))), io)).filter((f) => f.severity !== "minor")
  if (bad.length) return `A review of your diff against the spec found:\n${bad.map(showFinding).join("\n")}\nFix these.`
}

// CHECK: what the parent can establish without a model. The notes go back to the child.
async function check(t: RunTask, io: IO, child: Output): Promise<string | undefined> {
  const { files, uncommitted } = await io.changed(t)
  if (uncommitted.length) return `Uncommitted changes were left: ${uncommitted.join(", ")}. Commit them, or remove them.`
  if (!files.length) return `No commit was made${child.code ? ` (the agent: ${tail(child.output, 800)})` : ""}.`
  const outside = filesOutside(files, t.files)
  if (outside.length) return `The commits touch files outside the task's files: ${outside.join(", ")}. Touch only ${t.files.join(", ")}.`
  const red = t.mode === "tdd" && redFailure(t, await io.red(t))
  if (red) return red
  const v = await io.verify(t)
  if (v.code !== 0) return `The verify command \`${t.verify}\` failed (exit ${v.code}):\n${tail(v.output, 3000)}`
  return undefined
}

// On a stop the task is left running: start() puts it back to pending on the next run.
async function attempt(run: RunPlan, t: RunTask, io: IO, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) return
    const role = roleFor(t)
    io.log(`task ${t.id}: attempt ${(t.attempts ?? 0) + 1} on the ${role} role`)
    let child = await io.child(t, role, childPrompt(run, t))
    // A request is answered and the child started again in the same worktree, without a reset.
    for (let req = await io.request(t); req && !signal?.aborted; req = await io.request(t)) {
      t.answer = answer(run, t, req)
      io.log(`task ${t.id} asked for ${req.files.join(", ")} (${req.reason}): ${t.answer}`)
      io.save(run)
      if ((t.requests ?? 0) > MAX_REQUESTS) break // one request too many: checked as it stands
      child = await io.child(t, role, childPrompt(run, t))
    }
    delete t.answer
    if (signal?.aborted) return
    const failure = (await check(t, io, child)) ?? (signal?.aborted ? undefined : await judge(run, t, io))
    if (signal?.aborted) return // a killed verify is no failure of the task
    if (!failure) {
      t.status = "review"
      delete t.notes
      return io.save(run)
    }
    t.attempts = (t.attempts ?? 0) + 1
    t.notes = failure
    if (t.attempts >= MAX_ATTEMPTS) {
      t.status = "failed"
      return io.save(run)
    }
    delete t.requests // the next attempt starts from a clean worktree, and may ask again
    io.save(run)
    await io.prepare(t)
  }
}

// FINISH: the finish command, then every acceptance command, in the project.
async function finishFailures(run: RunPlan, io: IO): Promise<Failure[]> {
  const out: Failure[] = []
  for (const command of finishCommands(run)) {
    io.log(`finish: ${command}`)
    const f = await io.finish(command)
    if (f.code !== 0) out.push({ command, ...f })
  }
  return out
}

// One agent, one attempt, checked and landed as a task is. Returns why it did not land; an agent
// that may find nothing to do (optional) lands nothing without failing.
async function runJob(t: RunTask, prompt: string, io: IO, signal?: AbortSignal, optional = false): Promise<string | undefined> {
  io.log(t.title)
  await io.prepare(t)
  const child = await io.child(t, "large", prompt)
  if (signal?.aborted) return
  const kept = `\n  worktree .pi/worktrees/${safeId(t.id)} kept`
  const { files, uncommitted } = await io.changed(t)
  if (optional && !files.length && !uncommitted.length) return void (await io.remove(t))
  const failure = await check(t, io, child)
  if (failure) return failure + kept
  const error = await io.land(t)
  if (error) return `Landing failed: ${error}${kept}`
  await io.remove(t)
}

export async function runPlan(run: RunPlan, maxConcurrent: number, io: IO, signal?: AbortSignal): Promise<{ ok: boolean; message: string; findings?: Finding[] }> {
  let landFailed = false
  for (;;) {
    if (signal?.aborted) return { ok: false, message: `Stopped. /tasks run resumes.\n\n${summary(run)}` }
    const batch = nextBatch(run, maxConcurrent)
    if (!batch.length) break
    for (const t of batch) t.status = "running"
    io.save(run)
    io.log(`running ${batch.map((t) => t.id).join(", ")}`)
    for (const t of batch) await io.prepare(t) // one at a time: git locks the repository while it adds
    await Promise.all(batch.map((t) => attempt(run, t, io, signal)))

    // LAND: one task at a time, even after a stop, since landing is quick. The batch is unordered,
    // so the plan's order is a dependency order.
    for (const t of batch.filter((t) => t.status === "review")) {
      const error = await io.land(t)
      if (error) {
        t.status = "failed"
        t.notes = `Landing failed: ${error}`
        landFailed = true
        io.save(run)
        break
      }
      t.status = "done"
      await io.remove(t)
      io.save(run)
      io.log(`task ${t.id} landed`)
    }
    if (landFailed || batch.some((t) => t.status === "failed")) break
  }

  const failed = run.tasks.filter((t) => t.status === "failed")
  if (failed.length) {
    const why = failed.map((t) => `task ${t.id} ${t.title}: ${t.notes}\n  worktree .pi/worktrees/${safeId(t.id)} kept`).join("\n")
    return { ok: false, message: `Stopped.\n${why}\n/tasks run retries the failed tasks.\n\n${summary(run)}` }
  }
  if (run.tasks.some((t) => t.status !== "done")) return { ok: false, message: `Stopped with tasks that cannot start.\n${summary(run)}` }

  const stopped = { ok: false, message: `Stopped. /tasks run resumes.\n\n${summary(run)}` }
  let failures = await finishFailures(run, io)
  if (failures.length && !run.remediated) {
    const fix = job(run, "!fix", "fix the finish", failures.map((f) => f.command).join(" && "))
    const why = await runJob(fix, fixPrompt(fix, failures), io, signal)
    if (signal?.aborted) return stopped
    run.remediated = true
    io.save(run)
    failures = await finishFailures(run, io)
    if (failures.length) {
      const note = why ? `\nThe fix did not land: ${why}` : ""
      return { ok: false, message: `Every task landed, but these still fail after one fix:\n${showFailures(failures)}${note}\nFix them; /tasks run checks again.` }
    }
  }
  if (failures.length) return { ok: false, message: `Every task landed, but these fail, and the one fix was made:\n${showFailures(failures)}\nFix them; /tasks run checks again.` }
  const notes: string[] = []
  const verify = finishCommands(run).join(" && ") || "true"

  // SIMPLIFY: cuts to the build's diff, the finish commands still passing, in one commit or none.
  if (!run.simplified) {
    const t = job(run, "!simplify", "simplify the build", verify)
    const why = await runJob(t, simplifyPrompt(t, io.skill("simplify"), capped(await io.diff(undefined, run.base))), io, signal, true)
    if (signal?.aborted) return stopped
    if (why) notes.push(`Simplify did not land: ${why}`)
    run.simplified = true
    io.save(run)
  }

  // REVIEW: minor findings are fixed in one job; the others go to the user.
  let open: Finding[] = []
  if (!run.reviewed) {
    const diff = await io.diff(undefined, run.base)
    const kept = await findings(undefined, "large", reviewPrompt(run, capped(diff)), io)
    if (signal?.aborted) return stopped
    const minor = kept.filter((f) => f.severity === "minor")
    if (minor.length) {
      const t = job(run, "!review", "fix the review's minor findings", verify)
      const why = await runJob(t, minorPrompt(t, minor), io, signal)
      if (signal?.aborted) return stopped
      notes.push(why ? `The minor findings were not fixed: ${why}` : `Fixed ${minor.length} minor finding${minor.length === 1 ? "" : "s"}.`)
    }
    open = kept.filter((f) => f.severity !== "minor")
    const silent = silentFiles([...diff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1]), kept)
    notes.push(`Review: ${kept.length} finding${kept.length === 1 ? "" : "s"}.${silent.length ? ` No findings in: ${silent.join(", ")}.` : ""}`)
    if (open.length) notes.push(`To fix or skip:\n${open.map(showFinding).join("\n")}`)
    run.reviewed = true
    io.save(run)
  }

  run.status = "done"
  io.save(run)
  const manual = run.acceptance.filter((a) => a.kind === "manual").map((a) => `- ${a.id}: ${a.text}`)
  if (manual.length) notes.push(`Check by hand:\n${manual.join("\n")}`)
  return { ok: true, message: [summary(run), ...notes].join("\n\n"), findings: open }
}
