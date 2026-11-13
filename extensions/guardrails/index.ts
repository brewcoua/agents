import { readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import rules from "./rules.json"
import { type Env, type Rules, cap, decide, toolVerdict } from "./rules.ts"

const R = rules as Rules

// The tasks extension sets this in a task's child pi: a ":"-separated list of globs, relative to
// the project directory. Edit and write outside them are refused, and nothing asks. OTHALA_TASK_VERIFY
// is the one bash command the task may run besides `git add` of its files and `git commit`.
const TASK_FILES = process.env.OTHALA_TASK_FILES?.split(":").filter(Boolean)

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

// A file that does not exist yet resolves through its nearest existing directory.
function realpath(path: string): string {
  let dir = path
  let rest = ""
  for (;;) {
    try {
      return realpathSync(dir) + rest
    } catch {
      const i = dir.lastIndexOf("/")
      if (i <= 0) return path
      rest = dir.slice(i) + rest
      dir = dir.slice(0, i)
    }
  }
}

const env: Env = { home: homedir(), readFile, realpath, taskFiles: TASK_FILES, taskVerify: process.env.OTHALA_TASK_VERIFY }

async function enforce(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext) {
  const d = decide(R, env, toolName, input, ctx.cwd)
  if (d.verdict === "allow") return undefined
  if (d.verdict === "deny") return { block: true, reason: `Blocked by guardrails: ${d.reason}.` }
  if (!ctx.hasUI) {
    return { block: true, reason: `Blocked by guardrails: ${d.reason}, and there is no UI to ask the user. Run it yourself or change the approach.` }
  }
  const what = toolName === "bash" ? String(input.command) : `${toolName} ${String(input.path ?? "")}`
  const ok = await ctx.ui.confirm("Allow?", `${what}\n\n${d.reason}`)
  return ok ? undefined : { block: true, reason: "Blocked by guardrails: the user declined." }
}

export default function (pi: ExtensionAPI) {
  // Denied tools are not declared to the model. Codemode can still call tools
  // outside the active set, so tool_call below is the enforcement.
  const hide = () => {
    const active = pi.getActiveTools()
    const visible = active.filter((n) => toolVerdict(R, n) !== "deny")
    if (visible.length !== active.length) pi.setActiveTools(visible)
  }
  pi.on("session_start", hide)
  pi.on("before_agent_start", hide)

  pi.on("tool_call", (event, ctx) => enforce(event.toolName, event.input, ctx))

  pi.on("tool_result", (event) => {
    let changed = false
    const content = event.content.map((part) => {
      if (part.type !== "text") return part
      const text = cap(part.text, R.maxOutputChars)
      if (text === undefined) return part
      changed = true
      return { ...part, text }
    })
    return changed ? { content } : undefined
  })
}
