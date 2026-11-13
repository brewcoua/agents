// The runner's IO: git, the task agents and the verify commands. Thin on purpose; the logic is in run.ts and runner.ts.

import { execFile, spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { delimiter, join } from "node:path"
import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { Def } from "../agents/defs.ts"
import type { Spawner } from "../agents/runtime.ts"
import type { IO, Output } from "./runner.ts"
import { type Request, type RunTask, safeId, tail } from "./run.ts"

export const WORKTREES_DIR = ".pi/worktrees"
const CHILD_TIMEOUT_MS = 30 * 60_000
const KEEP_CHARS = 8000

const onPath = (name: string) => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, name)))

export function git(cwd: string, ...args: string[]): Promise<string> {
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

// setpriv --pdeathsig: the kernel kills a verify or finish command when this Pi dies, even by
// SIGKILL. What it started is left to killRun, which the next session start runs.
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
const branch = (t: RunTask) => `pi-task-${safeId(t.id)}`

// The agent a task runs as; its role is the task's, its prompt childPrompt (run.ts).
const TASK: Def = {
  name: "task",
  description: "One task of an approved plan, in its own worktree",
  role: "large",
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  maxTurns: 200, // the 30 minutes are the limit
  isolation: "off",
  allowedAgents: [],
  prompt: "You are one task of a plan that /tasks runs; the user's message is the task.",
  path: "extensions/tasks/git.ts",
}

export function gitIO(cwd: string, spawner: Spawner, save: IO["save"], log: IO["log"]): IO {
  const bases = new Map<string, string>()
  const requests = new Map<string, Request>()
  // Cargo keeps target/ per worktree; a shared cache would serialise the builds on its lock.
  const sccache: Record<string, string> = onPath("sccache") ? { RUSTC_WRAPPER: "sccache" } : {}
  const tree = (t: RunTask) => treeOf(cwd, safeId(t.id))
  const base = (t: RunTask) => bases.get(t.id) as string
  const requestFiles = (t: RunTask) =>
    defineTool({
      name: "request_files",
      label: "Request files",
      description:
        "Ask the task runner for permission to change files outside this task's files, with the reason. " +
        "Then end your turn: you are started again with the answer, and your changes so far are kept.",
      parameters: Type.Object({
        files: Type.Array(Type.String(), { minItems: 1, description: "Paths or globs, relative to the project" }),
        reason: Type.String({ description: "Why the task cannot be done without them" }),
      }),
      async execute(_id, p) {
        requests.set(t.id, p)
        return { content: [{ type: "text" as const, text: "Sent. End your turn now; you are started again with the answer." }], details: {} }
      },
    })
  return {
    save,
    log,
    async prepare(t) {
      const dir = worktreeDir(cwd, t)
      bases.set(t.id, (await git(cwd, "rev-parse", "HEAD")).trim())
      requests.delete(t.id)
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
    async child(t, role, prompt) {
      const a = spawner.spawn({
        owner: "tasks", def: { ...TASK, role }, prompt, description: `${t.id} ${t.title}`, cwd: worktreeDir(cwd, t),
        tools: [requestFiles(t)], guard: { taskFiles: t.files, taskVerify: t.verify },
        env: { ...sccache, OTHALA_TASK_TREE: tree(t) }, timeoutMs: CHILD_TIMEOUT_MS,
      })
      await spawner.wait(a)
      return { code: a.status === "done" ? 0 : 1, output: [a.error && `${a.status}: ${a.error}`, a.result].filter(Boolean).join("\n") }
    },
    async request(t) {
      const r = requests.get(t.id)
      requests.delete(t.id)
      return r
    },
    async changed(t) {
      const dir = worktreeDir(cwd, t)
      const lines = (s: string) => s.split("\n").filter(Boolean)
      return {
        files: lines(await git(dir, "diff", "--name-only", base(t), "HEAD")),
        uncommitted: lines(await git(dir, "status", "--porcelain")).map((l) => l.slice(3)),
      }
    },
    verify: (t) => sh(worktreeDir(cwd, t), "sh", ["-c", t.verify], { ...process.env, ...sccache }, tree(t)),
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
