import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import rules from "./rules.json"
import {
  type Decision,
  type Rules,
  cap,
  checkCommand,
  checkCommit,
  checkPath,
  glob,
  resolve,
  strictest,
  toolVerdict,
} from "./rules.ts"

const R = rules as Rules

// A task runner (the future `tasks` extension) sets this to a ":"-separated list
// of globs, relative to the project directory; edit and write outside them are refused.
const TASK_FILES = process.env.OTHALA_TASK_FILES?.split(":").filter(Boolean)

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"])

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function decide(toolName: string, input: Record<string, unknown>, cwd: string): Decision {
  let d: Decision = { verdict: toolVerdict(R, toolName), reason: `the ${toolName} tool needs confirmation` }
  if (d.verdict === "deny") return { verdict: "deny", reason: `the ${toolName} tool is denied` }

  if (toolName === "bash") {
    const command = String(input.command ?? "")
    d = strictest(d, checkCommand(R, command, cwd))
    d = strictest(d, checkCommit(command, (p) => readFile(resolve(cwd, p))) ?? d)
  } else if (PATH_TOOLS.has(toolName)) {
    const path = String(input.path ?? input.file_path ?? ".")
    d = strictest(d, checkPath(R, cwd, homedir(), path))
    if (TASK_FILES && (toolName === "edit" || toolName === "write")) {
      const rel = resolve(cwd, path).slice(cwd.length + 1)
      if (!TASK_FILES.some((g) => glob(g, rel))) {
        d = { verdict: "deny", reason: `${path} is outside the files of this task` }
      }
    }
  }
  return d
}

async function enforce(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext) {
  const d = decide(toolName, input, ctx.cwd)
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
