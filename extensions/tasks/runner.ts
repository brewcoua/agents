// The scheduler: steps 4 to 7 of the workflow over an injected IO, so node --test drives it
// with fakes. git.ts is the IO that runs git, the task agents and the verify commands.

import {
  MAX_ATTEMPTS, MAX_REQUESTS, type Failure, type Red, type Request, type RunPlan, type RunTask, answer, childPrompt, filesOutside, fixPrompt, fixTask, nextBatch, redFailure, safeId, roleFor, showFailures, summary, tail,
} from "./run.ts"
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
    const failure = await check(t, io, child)
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
  const commands = [...(run.finish ? [run.finish] : []), ...run.acceptance.filter((a) => a.kind === "command").map((a) => a.text)]
  const out: Failure[] = []
  for (const command of commands) {
    io.log(`finish: ${command}`)
    const f = await io.finish(command)
    if (f.code !== 0) out.push({ command, ...f })
  }
  return out
}

// One agent, one attempt, checked and landed as a task is. Returns why it did not land.
async function remediate(run: RunPlan, failures: Failure[], io: IO, signal?: AbortSignal): Promise<string | undefined> {
  const fix = fixTask(run, failures)
  io.log(`finish: one fix for ${failures.map((f) => f.command).join(", ")}`)
  await io.prepare(fix)
  const child = await io.child(fix, "large", fixPrompt(fix, failures))
  if (signal?.aborted) return
  run.remediated = true
  io.save(run)
  const failure = await check(fix, io, child)
  const kept = `\n  worktree .pi/worktrees/${safeId(fix.id)} kept`
  if (failure) return failure + kept
  const error = await io.land(fix)
  if (error) return `Landing failed: ${error}${kept}`
  await io.remove(fix)
}

export async function runPlan(run: RunPlan, maxConcurrent: number, io: IO, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
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

  let failures = await finishFailures(run, io)
  if (failures.length && !run.remediated) {
    const why = await remediate(run, failures, io, signal)
    if (signal?.aborted) return { ok: false, message: `Stopped. /tasks run resumes.\n\n${summary(run)}` }
    failures = await finishFailures(run, io)
    if (failures.length) {
      const fix = why ? `\nThe fix did not land: ${why}` : ""
      return { ok: false, message: `Every task landed, but these still fail after one fix:\n${showFailures(failures)}${fix}\nFix them; /tasks run checks again.` }
    }
  }
  if (failures.length) return { ok: false, message: `Every task landed, but these fail, and the one fix was made:\n${showFailures(failures)}\nFix them; /tasks run checks again.` }
  run.status = "done"
  io.save(run)
  const manual = run.acceptance.filter((a) => a.kind === "manual").map((a) => `- ${a.id}: ${a.text}`)
  return { ok: true, message: summary(run) + (manual.length ? `\n\nCheck by hand:\n${manual.join("\n")}` : "") }
}
