export const MAX_DIFF_CHARS = 60_000

export type Args = { ref?: string } | { error: string }

// `/simplify [ref]`: at most one ref, and never an option for git to parse.
export function parseArgs(args: string): Args {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) return { error: "usage: /simplify [ref]" }
  if (words[0]?.startsWith("-")) return { error: `${words[0]} is not a ref` }
  return { ref: words[0] }
}

// Whole files only: a diff cut mid-hunk misleads. Files that do not fit are named.
export function capDiff(diff: string, max: number): { text: string; omitted: string[] } {
  const parts = diff.split(/^(?=diff --git )/m).filter(Boolean)
  const kept: string[] = []
  const omitted: string[] = []
  let size = 0
  for (const part of parts) {
    if (size + part.length <= max) {
      kept.push(part)
      size += part.length
    } else {
      omitted.push(/^diff --git a\/.* b\/(.*)$/m.exec(part)?.[1] ?? part.split("\n")[0])
    }
  }
  return { text: kept.join(""), omitted }
}
