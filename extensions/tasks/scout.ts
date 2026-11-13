// Pure part of the scout tool: no Pi imports, so node --test runs it.
import type { Model } from "../lib/profiles.ts"

export const MAX_SCOUTS = 6
export const SCOUT_TIMEOUT_MS = 180_000
export const SCOUT_MAX_CHARS = 8000

// A child pi: one prompt, no session, read-only tools, no MCP, and -na so a project's
// own extensions and settings are not loaded (print mode cannot ask for trust).
export function scoutArgs(model: Model, question: string): string[] {
  return [
    "-p", "--no-session", "--no-mcp", "-na",
    "--provider", model.provider, "--model", model.id,
    "-t", "read,grep,find,ls",
    `You are a read-only research scout. Answer the question below from the files of this project. Do not suggest changes. ` +
      `Reply with findings only: paths with line numbers, short quotes, no preamble.\n\nQuestion: ${question}`,
  ]
}

export type ScoutResult = { code: number | null; killed: boolean; stdout: string; stderr: string }

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]`
}

export function formatScouts(questions: string[], results: ScoutResult[]): string {
  return results
    .map((r, i) => {
      const head = `## Scout ${i + 1}: ${questions[i]}`
      if (r.killed) return `${head}\nfailed: timed out or output too large`
      if (r.code !== 0) return `${head}\nfailed (exit ${r.code}): ${clip(r.stderr.trim(), 500)}`
      return `${head}\n${clip(r.stdout.trim(), SCOUT_MAX_CHARS) || "(no output)"}`
    })
    .join("\n\n")
}
