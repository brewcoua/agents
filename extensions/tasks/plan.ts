// Pure logic of the tasks extension's planning half: no Pi imports, so node --test runs it.
// The plan file format is documented in docs/25-pi.md ("Tasks"); PLAN_FORMAT below is what the model sees.

import { type Decision, type Rules, checkCommand, resolve } from "../guardrails/rules.ts"

export const PLANS_DIR = ".pi/plans"

export type Task = {
  id: string
  parent?: string
  title: string
  deps: string[]
  files: string[]
  tier: "large" | "small"
  verify: string
  accept: string
}
export type Plan = { status: string | undefined; title: string; tasks: Task[]; errors: string[] }

export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "")
  return s || "plan"
}

export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  let s = base
  for (let n = 2; taken(s); n++) s = `${base}-${n}`
  return s
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/

export function planStatus(text: string): string | undefined {
  return FRONTMATTER.exec(text)?.[1].match(/^status:\s*(\S+)/m)?.[1]
}

export function withStatus(text: string, status: string): string {
  const m = FRONTMATTER.exec(text)
  if (!m) return `---\nstatus: ${status}\n---\n${text}`
  const head = /^status:.*$/m.test(m[1]) ? m[1].replace(/^status:.*$/m, `status: ${status}`) : `status: ${status}\n${m[1]}`
  return `---\n${head}\n---\n${text.slice(m[0].length)}`
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean)

export function parsePlan(text: string): Plan {
  const errors: string[] = []
  const body = text.replace(FRONTMATTER, "")
  const title = /^# (.+)$/m.exec(body)?.[1].trim() ?? ""
  if (!title) errors.push("no `# Title` line")

  const tasks: Task[] = []
  const section = /^## Tasks[ \t]*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)?.[1]
  const blocks = section ? section.split(/^### /m).slice(1) : []
  for (const block of blocks) {
    const [head, ...lines] = block.split("\n")
    const [id, ...words] = head.trim().split(/\s+/)
    const f: Record<string, string> = {}
    for (const line of lines) {
      const m = /^- (parent|deps|files|tier|verify|accept):\s*(.*)$/.exec(line)
      if (m) f[m[1]] = m[2].trim()
    }
    const missing = ["files", "tier", "verify", "accept"].filter((k) => !f[k])
    if (!id || words.length === 0) errors.push(`task heading "${head.trim()}" is not "### <id> <title>"`)
    if (missing.length) errors.push(`task ${id}: missing ${missing.join(", ")}`)
    if (f.tier && f.tier !== "large" && f.tier !== "small") errors.push(`task ${id}: tier must be large or small`)
    const parent = f.parent || (id?.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "")
    tasks.push({
      id,
      ...(parent ? { parent } : {}),
      title: words.join(" "),
      deps: list(f.deps ?? ""),
      files: list(f.files ?? ""),
      tier: f.tier as Task["tier"],
      verify: f.verify ?? "",
      accept: f.accept ?? "",
    })
  }

  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`task id ${t.id} is used twice`)
    ids.add(t.id)
  }
  for (const t of tasks) {
    for (const d of t.deps) if (d === t.id || !ids.has(d)) errors.push(`task ${t.id}: unknown dependency ${d}`)
    if (t.parent && !ids.has(t.parent)) errors.push(`task ${t.id}: unknown parent ${t.parent}`)
  }
  return { status: planStatus(text), title, tasks, errors }
}

// One task or none: the session implements it itself, with no task tree.
export const isSmall = (plan: Plan) => plan.tasks.length <= 1

// A comment is `>>` lines under the `>` lines they are about.
export type Comment = { quote: string; comment: string }

export function parseComments(text: string): Comment[] {
  const out: Comment[] = []
  const lines = text.split("\n")
  let quote: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(">>")) {
      const body: string[] = []
      for (; i < lines.length && lines[i].startsWith(">>"); i++) body.push(lines[i].replace(/^>>[ \t]?/, ""))
      i--
      const comment = body.join("\n").trim()
      if (comment) out.push({ quote: quote.join("\n"), comment })
      quote = []
    } else if (lines[i].startsWith(">")) quote.push(lines[i].replace(/^>[ \t]?/, ""))
    else quote = []
  }
  return out
}

export function commentsMessage(path: string, comments: Comment[]): string {
  const items = comments.map((c, i) => `${i + 1}. ${c.quote ? `On:\n${c.quote.replace(/^/gm, "   > ")}\n   ` : ""}Comment: ${c.comment}`)
  return (
    `The user reviewed ${path} and left ${comments.length} comment${comments.length === 1 ? "" : "s"}:\n\n${items.join("\n\n")}\n\n` +
    "Revise the plan file to address them, and delete every `>` quote and `>>` comment line from it as you do. " +
    "Ask with ask_user_question if a comment is unclear. Then say what changed, briefly."
  )
}

// Tools a planning session may call as they are; guardrails still judges them.
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "scout", "ask_user_question", "web_search", "web_fetch"])

// ask counts as deny: there is nobody to answer while the model plans.
export function planVerdict(rules: Rules, tool: string, input: Record<string, unknown>, cwd: string): Decision {
  if (tool === "edit" || tool === "write") {
    const path = String(input.path ?? input.file_path ?? "")
    if (resolve(cwd, path).startsWith(`${cwd}/${PLANS_DIR}/`)) return { verdict: "allow", reason: "" }
    return { verdict: "deny", reason: `plan mode: ${tool} is only allowed under ${PLANS_DIR}/` }
  }
  if (tool === "bash") {
    const d = checkCommand(rules, String(input.command ?? ""), cwd)
    if (d.verdict === "allow") return d
    return { verdict: "deny", reason: `plan mode: only read-only commands run (${d.reason})` }
  }
  if (READ_ONLY_TOOLS.has(tool)) return { verdict: "allow", reason: "" }
  return { verdict: "deny", reason: `plan mode: the ${tool} tool is not available` }
}

export const PLAN_FORMAT = `---
status: draft
---
# <title>

## Goal
<what and why, a few lines>

## Decisions
- <a choice made, and why>

## Open questions
- <only what the user must still decide; none is fine>

## Tasks
### 1 <title>
- deps: <ids, comma separated; omit if none>
- files: <paths or globs this task may touch, comma separated>
- tier: <small or large>
- verify: <one command that fails until the task is done>
- accept: <one sentence a reviewer can check>

Ids are strings ("1", "2", "2.1"); "2.1" is a subtask of "2" unless a \`- parent:\` line says otherwise.
Tasks whose files overlap must depend on each other. Tier small is for mechanical, well-specified work, large for the rest.
A small change is one task (or no Tasks section).`

export function planPrompt(path: string): string {
  return [
    "[PLAN MODE] You are planning, not implementing. Nothing in the project may change except the plan file.",
    `- Write the plan to ${path} with the write tool, in exactly this format:\n\n${PLAN_FORMAT}\n`,
    "- edit and write are refused outside .pi/plans/; bash runs read-only commands only.",
    "- Research with read, grep, find, ls. For wide questions use the scout tool: several read-only scouts run in parallel on a cheaper model.",
    "- Ask the user with ask_user_question, in one call, whenever a decision is theirs. Do not guess; record the answer under Decisions.",
    "- The user reads the plan in their editor and comments on it. When you finish a draft, say it is ready for /plan review, and stop.",
  ].join("\n")
}

export function implementMessage(path: string, text: string): string {
  return `The plan at ${path} is approved. Implement it now, in this session, and run its verify command.\n\n${text}`
}
