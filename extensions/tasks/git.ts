// The runner's IO: git and the child pi processes. Thin on purpose; the logic is in run.ts and runner.ts.

import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import type { IO, Output } from "./runner.ts"
import { type RunPlan, type RunTask, childArgs, childEnv, safeId, tail } from "./run.ts"
import type { Tiers } from "./tiers.ts"

export const WORKTREES_DIR = ".pi/worktrees"
const CHILD_TIMEOUT_MS = 30 * 60_000
const KEEP_CHARS = 8000

const onPath = (name: string) => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, name)))

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((done, fail) =>
    execFile("git", args, { cwd, maxBuffer: 32 << 20 }, (e, stdout, stderr) =>
      e ? fail(new Error(`git ${args.join(" ")}: ${stderr.trim() || e.message}`)) : done(stdout),
    ),
  )
}

function sh(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<Output> {
  return new Promise((done) => {
    let output = ""
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: CHILD_TIMEOUT_MS })
    const keep = (d: Buffer) => (output = tail(output + d, KEEP_CHARS))
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    child.on("error", (e) => done({ code: null, output: `${command}: ${e.message}` }))
    child.on("close", (code) => done({ code, output }))
  })
}

export const worktreeDir = (cwd: string, t: RunTask) => join(cwd, WORKTREES_DIR, safeId(t.id))
const branch = (t: RunTask) => `pi-task-${safeId(t.id)}`

export function leftovers(cwd: string, run: RunPlan): RunTask[] {
  return run.tasks.filter((t) => t.status === "pending" && existsSync(worktreeDir(cwd, t)))
}

export function gitIO(cwd: string, tiers: Tiers, save: (run: RunPlan) => void, log: (message: string) => void): IO {
  const bases = new Map<string, string>()
  const sccache = onPath("sccache")
  const env = (t: RunTask) => childEnv(t, process.env, sccache)
  const base = (t: RunTask) => bases.get(t.id) as string
  return {
    save,
    log,
    async prepare(t) {
      const dir = worktreeDir(cwd, t)
      bases.set(t.id, (await git(cwd, "rev-parse", "HEAD")).trim())
      if (existsSync(dir)) {
        await git(dir, "reset", "--hard", base(t))
        await git(dir, "clean", "-fdq")
      } else {
        await git(cwd, "worktree", "prune")
        // -B: a branch left by a worktree the user discarded is reused
        await git(cwd, "worktree", "add", dir, "-B", branch(t), base(t))
      }
    },
    child: (t, tier, prompt) => sh(worktreeDir(cwd, t), "pi", childArgs(tiers[tier], prompt), env(t)),
    async changed(t) {
      const dir = worktreeDir(cwd, t)
      const lines = (s: string) => s.split("\n").filter(Boolean)
      return {
        files: lines(await git(dir, "diff", "--name-only", base(t), "HEAD")),
        uncommitted: lines(await git(dir, "status", "--porcelain")).map((l) => l.slice(3)),
      }
    },
    verify: (t) => sh(worktreeDir(cwd, t), "sh", ["-c", t.verify], env(t)),
    async land(t) {
      try {
        await git(cwd, "cherry-pick", `${base(t)}..${branch(t)}`)
      } catch (e) {
        await git(cwd, "cherry-pick", "--abort").catch(() => {})
        return e instanceof Error ? e.message : String(e)
      }
    },
    async remove(t) {
      await git(cwd, "worktree", "remove", "--force", worktreeDir(cwd, t))
      await git(cwd, "branch", "-D", branch(t)).catch(() => {}) // already gone is fine
    },
    finish: (command) => sh(cwd, "sh", ["-c", command], process.env),
  }
}
