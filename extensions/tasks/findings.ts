// Findings of the judge and the review: pure, so node --test runs it. The agents write
// `path:line  severity  text  \`quote\``, one per line (agents/review.md).

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
