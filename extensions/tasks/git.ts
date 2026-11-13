// The runner's IO: git and the child pi processes. Thin on purpose; the logic is in run.ts and runner.ts.

import { execFile, spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { delimiter, join } from "node:path"
import { type Usage, readReport } from "../budget/limits.ts"
import type { IO, Output } from "./runner.ts"
import { type Request, type RunTask, childArgs, childEnv, safeId, tail } from "./run.ts"
import type { Roles } from "../lib/profiles.ts"

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

// Every process of a run carries OTHALA_TASK_TREE=<project>#<task>, inherited by whatever it
// starts. Reading /proc/<pid>/environ finds them all, whatever their process group or parent.
export const treeOf = (cwd: string, id: string) => `${cwd}#${id}`

export function kill(match: (tree: string) => boolean): number {
  let n = 0
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p) || Number(p) === process.pid) continue
    try {
      const tree = readFileSync(`/proc/${p}/environ`, "latin1").split("\0").find((e) => e.startsWith("OTHALA_TASK_TREE="))
      if (tree && match(tree.slice("OTHALA_TASK_TREE=".length))) (process.kill(Number(p), "SIGKILL"), n++)
    } catch {} // gone, or not ours to read
  }
  return n
}

export const killRun = (cwd: string) => kill((tree) => tree.startsWith(`${cwd}#`))

// setpriv --pdeathsig: the kernel kills the child when this Pi dies, even by SIGKILL. What the
// child started is left to killRun, which the next session start runs.
const setpriv = onPath("setpriv")

function sh(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv, tree: string): Promise<Output> {
  return new Promise((done) => {
    let output = ""
    const argv = setpriv ? ["--pdeathsig", "KILL", "--", command, ...args] : args
    const child = spawn(setpriv ? "setpriv" : command, argv, { cwd, env: { ...env, OTHALA_TASK_TREE: tree }, stdio: ["ignore", "pipe", "pipe"] })
    const timer = setTimeout(() => kill((t) => t === tree), CHILD_TIMEOUT_MS)
    const keep = (d: Buffer) => (output = tail(output + d, KEEP_CHARS))
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    child.on("error", (e) => (clearTimeout(timer), done({ code: null, output: `${command}: ${e.message}` })))
    child.on("close", (code) => (clearTimeout(timer), done({ code, output })))
  })
}

export const worktreeDir = (cwd: string, t: RunTask) => join(cwd, WORKTREES_DIR, safeId(t.id))
const requestFile = (cwd: string, t: RunTask) => join(cwd, WORKTREES_DIR, `${safeId(t.id)}.request.json`)
const usageFile = (cwd: string, t: RunTask) => join(cwd, WORKTREES_DIR, `${safeId(t.id)}.usage.json`)

// What the child's budget extension wrote, taken once.
export function takeUsage(file: string): Usage | undefined {
  let text: string | undefined
  try {
    text = readFileSync(file, "utf8")
    rmSync(file, { force: true })
  } catch {}
  return readReport(text)
}
const branch = (t: RunTask) => `pi-task-${safeId(t.id)}`

export function gitIO(cwd: string, roles: Roles, save: IO["save"], log: IO["log"], usage: (u: Usage) => void): IO {
  const bases = new Map<string, string>()
  const sccache = onPath("sccache")
  const tree = (t: RunTask) => treeOf(cwd, safeId(t.id))
  const env = (t: RunTask) => childEnv(t, process.env, sccache, requestFile(cwd, t))
  const base = (t: RunTask) => bases.get(t.id) as string
  return {
    save,
    log,
    async prepare(t) {
      const dir = worktreeDir(cwd, t)
      bases.set(t.id, (await git(cwd, "rev-parse", "HEAD")).trim())
      rmSync(requestFile(cwd, t), { force: true })
      if (existsSync(dir)) {
        try {
          await git(dir, "reset", "--hard", base(t))
          await git(dir, "clean", "-fdq")
          return
        } catch {
          // a git killed mid-command leaves index.lock behind: start the worktree over
          rmSync(dir, { recursive: true, force: true })
        }
      }
      await git(cwd, "worktree", "prune")
      // -B: a branch left by a worktree the user discarded is reused
      await git(cwd, "worktree", "add", dir, "-B", branch(t), base(t))
    },
    async child(t, tier, prompt) {
      const file = usageFile(cwd, t)
      const out = await sh(worktreeDir(cwd, t), "pi", childArgs(roles[tier], prompt), { ...env(t), OTHALA_BUDGET_REPORT: file }, tree(t))
      const u = takeUsage(file)
      if (u) usage(u)
      return out
    },
    async request(t) {
      const file = requestFile(cwd, t)
      if (!existsSync(file)) return undefined
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Request
      } catch {
        return { files: [], reason: "unreadable request" }
      } finally {
        rmSync(file, { force: true })
      }
    },
    async changed(t) {
      const dir = worktreeDir(cwd, t)
      const lines = (s: string) => s.split("\n").filter(Boolean)
      return {
        files: lines(await git(dir, "diff", "--name-only", base(t), "HEAD")),
        uncommitted: lines(await git(dir, "status", "--porcelain")).map((l) => l.slice(3)),
      }
    },
    verify: (t) => sh(worktreeDir(cwd, t), "sh", ["-c", t.verify], env(t), tree(t)),
    // Rebased in the task's worktree, then a fast-forward: HEAD moves once or not at all, so an
    // interruption never leaves a half-applied series in the project.
    async land(t) {
      const dir = worktreeDir(cwd, t)
      try {
        await git(dir, "rebase", (await git(cwd, "rev-parse", "HEAD")).trim())
      } catch (e) {
        await git(dir, "rebase", "--abort").catch(() => {})
        return e instanceof Error ? e.message : String(e)
      }
      try {
        await git(cwd, "merge", "--ff-only", branch(t))
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    },
    async remove(t) {
      await git(cwd, "worktree", "remove", "--force", worktreeDir(cwd, t))
      await git(cwd, "branch", "-D", branch(t)).catch(() => {}) // already gone is fine
    },
    finish: (command) => sh(cwd, "sh", ["-c", command], process.env, treeOf(cwd, "!finish")), // no task id has "!"
  }
}
