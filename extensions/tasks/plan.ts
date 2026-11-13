// Pure logic of the tasks extension's planning half: no Pi imports, so node --test runs it.
// The plan file format is documented in docs/25-pi.md ("Tasks"); PLAN_FORMAT below is what the model sees.

import { type Decision, type Rules, checkCommand, glob, resolve } from "../guardrails/rules.ts"

export const PLANS_DIR = ".pi/plans"

export type Task = {
  id: string
  parent?: string
  title: string
  deps: string[]
  files: string[]
  tests: string[] // the subset of files the red commit may touch
  role: "large" | "small"
  mode: string // "tdd", or "direct: <reason>"
  spec: string
  verify: string
  covers: string[] // acceptance ids
}
// "## Acceptance": `- a1: \`<command>\` exits 0`, `- a2: manual: <check>` or `- a3: deferred: <reason>`.
export type Acceptance = { id: string; kind: "command" | "manual" | "deferred"; text: string }
export type Plan = { status: string | undefined; title: string; acceptance: Acceptance[]; tasks: Task[]; errors: string[] }

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
export const sectionOf = (body: string, name: string) => new RegExp(`^## ${name}[ \\t]*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(body)?.[1].trim() ?? ""

function parseAcceptance(section: string, errors: string[]): Acceptance[] {
  const items: Acceptance[] = []
  for (const line of section.split("\n")) {
    const m = /^- ([\w.-]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const [, id, rest] = m
    const command = /^`(.+)`\s+exits 0$/.exec(rest)
    const other = /^(manual|deferred):\s*(\S.*)$/.exec(rest)
    if (items.some((a) => a.id === id)) errors.push(`acceptance id ${id} is used twice`)
    if (command) items.push({ id, kind: "command", text: command[1] })
    else if (other) items.push({ id, kind: other[1] as Acceptance["kind"], text: other[2] })
    else errors.push(`acceptance ${id}: not "\`<command>\` exits 0", "manual: <check>" or "deferred: <reason>"`)
  }
  return items
}

export function parsePlan(text: string): Plan {
  const errors: string[] = []
  const body = text.replace(FRONTMATTER, "")
  const title = /^# (.+)$/m.exec(body)?.[1].trim() ?? ""
  if (!title) errors.push("no `# Title` line")

  const acceptance = parseAcceptance(sectionOf(body, "Acceptance"), errors)
  const tasks: Task[] = []
  const blocks = sectionOf(body, "Tasks").split(/^### /m).slice(1)
  for (const block of blocks) {
    const [head, ...lines] = block.split("\n")
    const [id, ...words] = head.trim().split(/\s+/)
    const f: Record<string, string> = {}
    for (const line of lines) {
      const m = /^- (parent|deps|files|tests|role|mode|spec|verify|covers):\s*(.*)$/.exec(line)
      if (m) f[m[1]] = m[2].trim()
    }
    const missing = ["files", "role", "mode", "spec", "verify"].filter((k) => !f[k])
    if (!id || words.length === 0) errors.push(`task heading "${head.trim()}" is not "### <id> <title>"`)
    if (missing.length) errors.push(`task ${id}: missing ${missing.join(", ")}`)
    if (f.role && f.role !== "large" && f.role !== "small") errors.push(`task ${id}: role must be large or small`)
    if (f.mode && f.mode !== "tdd" && !/^direct:\s*\S/.test(f.mode)) errors.push(`task ${id}: mode must be tdd, or direct: <reason>`)
    const files = list(f.files ?? "")
    const tests = list(f.tests ?? "")
    if (f.mode === "tdd" && !tests.length) errors.push(`task ${id}: a tdd task needs tests`)
    const stray = tests.filter((x) => !files.some((g) => glob(g, x)))
    if (stray.length) errors.push(`task ${id}: tests ${stray.join(", ")} not in its files`)
    const parent = f.parent || (id?.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "")
    tasks.push({
      id,
      ...(parent ? { parent } : {}),
      title: words.join(" "),
      deps: list(f.deps ?? ""),
      files,
      tests,
      role: f.role as Task["role"],
      mode: f.mode ?? "",
      spec: f.spec ?? "",
      verify: f.verify ?? "",
      covers: list(f.covers ?? ""),
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
    for (const c of t.covers) if (!acceptance.some((a) => a.id === c)) errors.push(`task ${t.id}: covers ${c}, which is no acceptance item`)
  }
  // With no tasks the session implements the plan itself, and nothing is there to cover.
  for (const a of tasks.length ? acceptance : []) {
    if (a.kind !== "deferred" && !tasks.some((t) => t.covers.includes(a.id))) errors.push(`acceptance ${a.id} is covered by no task; cover it, or make it deferred: <reason>`)
  }
  return { status: planStatus(text), title, acceptance, tasks, errors }
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
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "scout", "ask_user_question", "web_search", "web_fetch", "agent_result", "acceptance_check"])
// Agent types a planning session may start: none of them writes.
const READ_ONLY_AGENTS = ["scout", "research", "locate", "precedent"]

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
  if (tool === "agent") {
    if (READ_ONLY_AGENTS.includes(String(input.type)) && !input.resume && input.isolation !== "worktree") return { verdict: "allow", reason: "" }
    return { verdict: "deny", reason: `plan mode: only ${READ_ONLY_AGENTS.join(", ")} agents, new and without a worktree` }
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

## Acceptance
- a1: \`<a read-only command that measures the outcome>\` exits 0
- a2: manual: <a check no command can make>
- a3: deferred: <an outcome this plan leaves out, and why>

## Tasks
### 1 <title>
- deps: <ids, comma separated; omit if none>
- files: <paths or globs this task may touch, comma separated>
- tests: <the subset of files that holds this task's tests>
- role: <small or large>
- mode: <tdd, or direct: <why no test can describe it>>
- spec: <the behaviours the tests must show, in words>
- verify: <one command that fails until the task is done>
- covers: <the acceptance ids this task makes pass, comma separated; omit if none>

Ids are strings ("1", "2", "2.1"); "2.1" is a subtask of "2" unless a \`- parent:\` line says otherwise.
Tasks whose files overlap must depend on each other. Role small is for mechanical, well-specified work, large for the rest.
Every acceptance item is covered by a task or deferred. A tdd task writes its tests first and needs tests; direct is for
work no test can describe (documentation, configuration). No implementation code in the plan.
A small change is one task (or no Tasks section).

## Finish
<optional: one command that runs the project's full test suite once every task has landed>`

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

// /build and /research: plan mode with stages. research: forced on or off; absent, the model decides.
export type Mode = { path: string; mode?: "build" | "research"; research?: boolean; from?: boolean }

export function buildArgs(args: string): { request?: string; from?: string; research?: boolean } | { error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const usage = { error: "usage: /build [--research | --no-research] <request>, or /build --from <slug>" }
  if (words[0] === "--from") return words.length === 2 ? { from: words[1] } : usage
  const research = words[0] === "--research" ? true : words[0] === "--no-research" ? false : undefined
  const rest = research === undefined ? words : words.slice(1)
  if (!rest.length || rest[0].startsWith("--")) return usage
  return { request: rest.join(" "), ...(research === undefined ? {} : { research }) }
}

export const researchPath = (path: string) => path.replace(/\.md$/, ".research.md")

const researchSteps = (path: string) =>
  "Turn the request into 3 to 6 questions and start one agent per question with the agent tool, all in one turn: scout (documentation " +
  "and the web), research (broad questions: what other tools do, how designs compare), locate (where the code involved lives), " +
  `precedent (past commits on that code, and the fixes that followed). Write ${researchPath(path)}: each finding with its source, ` +
  "a URL or file:line, and the questions no agent answered listed as open, not guessed."

const LATER = (path: string) => [
  "3. Approaches. Propose 2 or 3 approaches, each with what it keeps, what it costs and the findings it rests on. The user picks one " +
    "with ask_user_question, combines them, or sends research back with a new question. Record the choice under ## Decisions.",
  `4. Acceptance. Write ## Acceptance in ${path} from the request alone; research only helps write the commands. Items a1, a2, ..., ` +
    "each a read-only command that measures the outcome itself, or manual when no command can. Call acceptance_check: every command " +
    "must fail on the current tree. Rewrite or drop one that passes, and check again.",
  "5. Plan. Write the tasks of the chosen approach. Every acceptance item is covered by a task or deferred with a reason; nothing " +
    "outside the request is planned. Prefer mode tdd. No implementation code in the plan: the tests drive the design.",
  "Then say the plan is ready for /plan review, and stop.",
]

export function modePrompt(m: Mode): string {
  const name = (m.path.split("/").pop() ?? "").replace(/\.md$/, "")
  if (m.mode === "research")
    return [`[RESEARCH] Research the user's question, and do not plan. ${researchSteps(m.path)}`, `Then stop; /build --from ${name} builds from it.`].join("\n")
  if (m.mode !== "build") return ""
  const research =
    m.research === true ? "Research runs: the user asked for it." :
    m.research === false ? "Skip research: the user said so." :
    "Decide whether research runs, and say why: it runs for a new feature, an unfamiliar library or a choice between designs, " +
      "and is skipped for a change you can place in a file or two."
  const first = m.from
    ? [`[BUILD] This plan is a build, from research done before. Read ${researchPath(m.path)}, then take it through these stages; stop only where a decision is the user's.`]
    : [
        "[BUILD] This plan is a build: take the request through these stages, in order, and stop only where a decision is the user's.",
        "1. Intake. Ask with ask_user_question: first the user's intent, with no recommended option; then only the questions whose " +
          "answers change the work, each citing the code it comes from (file:line) and offering 2 to 4 options stated as tradeoffs " +
          '("keeps X, loses Y"). No confirmation questions, no closing "looks good?".',
        `2. Research. ${research} ${researchSteps(m.path)}`,
      ]
  return [...first, ...LATER(m.path)].join("\n")
}

// acceptance_check's answer: an item that passes before the change measures nothing.
export function acceptanceReport(items: Acceptance[], results: Record<string, { code: number | null; output: string }>): string {
  if (!items.length) return "No acceptance items: write ## Acceptance in the plan first."
  return items
    .filter((a) => a.kind !== "deferred")
    .map((a) => {
      if (a.kind === "manual") return `${a.id}: manual, not run.`
      const r = results[a.id]
      if (r.code !== 0) return `${a.id}: fails (exit ${r.code}), as it must.`
      return `${a.id}: passes on the current tree: it does not measure the change. Rewrite it or drop it, then check again.`
    })
    .join("\n")
}
