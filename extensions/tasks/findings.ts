// Findings of the judge and the review, and the prompts that ask for them: pure, so node --test
// runs it. The agents write `path:line  severity  text  \`quote\``, one per line (agents/review.md).

import type { RunPlan, RunTask } from "./run.ts"

export type Severity = "blocker" | "major" | "minor"
export type Finding = { path: string; line: number; severity: Severity; text: string; quote: string }

const NEAR = 3 // lines a quote may sit from the line it cites

export function parseFindings(output: string): Finding[] {
  const out: Finding[] = []
  for (const line of output.split("\n")) {
    const m = /^\s*(?:[-*]\s+)?(\S+):(\d+)\s+(blocker|major|minor)\s+(.*\S)\s+`([^`]+)`\s*$/.exec(line)
    if (m) out.push({ path: m[1], line: Number(m[2]), severity: m[3] as Severity, text: m[4], quote: m[5] })
  }
  return out
}

// A finding stands only on a quote found in its file, at or near the line it cites.
export function checkFindings(findings: Finding[], read: (path: string) => string | undefined): { kept: Finding[]; dropped: Finding[] } {
  const kept: Finding[] = []
  const dropped: Finding[] = []
  for (const f of findings) {
    const lines = read(f.path)?.split("\n") ?? []
    const q = f.quote.trim()
    const found = q !== "" && lines.slice(Math.max(0, f.line - 1 - NEAR), f.line + NEAR).some((l) => l.includes(q))
    ;(found ? kept : dropped).push(f)
  }
  return { kept, dropped }
}

// Changed files no finding is about, so the review's silence on them is visible.
export const silentFiles = (changed: string[], kept: Finding[]) => changed.filter((p) => !kept.some((f) => f.path === p))

export const showFinding = (f: Finding) => `${f.path}:${f.line}  ${f.severity}  ${f.text}  \`${f.quote}\``

const FORMAT =
  "Report as your instructions say: one `path:line  severity  text  `quote`` line per finding, the quote copied from the file, " +
  "then the changed files with none. blocker: wrong or unsafe as it stands, or short of what it was for. " +
  "major: works, but must change before it lands. minor: worth fixing, not blocking."

const acceptanceList = (run: RunPlan, ids?: string[]) =>
  run.acceptance.filter((a) => !ids || ids.includes(a.id)).map((a) => `- ${a.id}: ${a.kind === "command" ? `\`${a.text}\` exits 0` : `${a.kind}: ${a.text}`}`).join("\n")

const fence = (diff: string) => `\`\`\`diff\n${diff}\`\`\``

// The judge of one task: its diff against its spec, never its author's reasoning.
export function judgePrompt(run: RunPlan, t: RunTask, diff: string): string {
  const covers = acceptanceList(run, t.covers)
  return [
    "Judge one task of a plan: does its diff do what its spec says, and only that? This worktree is at the task's last commit; read around the diff as you need.",
    `Goal of the plan: ${run.goal}`,
    `Task ${t.id}: ${t.title}\nSpec: ${t.spec}${covers ? `\nAcceptance it covers:\n${covers}` : ""}`,
    FORMAT,
    fence(diff),
  ].join("\n\n")
}

// The review of the whole build, once every task has landed.
export function reviewPrompt(run: RunPlan, diff: string): string {
  return [
    `Review the change that built this plan, from ${run.base} to HEAD, in this project.`,
    `Plan: ${run.title}\nGoal: ${run.goal}${run.acceptance.length ? `\nAcceptance:\n${acceptanceList(run)}` : ""}`,
    `Its tasks, each part of what was asked:\n${run.tasks.map((t) => `- ${t.id} ${t.title}: ${t.spec}`).join("\n")}`,
    FORMAT,
    fence(diff),
  ].join("\n\n")
}
