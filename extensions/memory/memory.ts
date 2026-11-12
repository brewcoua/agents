// Pure logic of the memory extension: file format and index. No Pi, no disk.

export const TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof TYPES)[number]

export interface Memory {
  name: string
  description: string
  type: MemoryType
  body: string
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

export function slug(name: string): string {
  return oneLine(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export function format(m: Memory): string {
  return `---\nname: ${oneLine(m.name)}\ndescription: ${oneLine(m.description)}\ntype: ${m.type}\n---\n\n${m.body.trim()}\n`
}

export function parse(text: string): Memory | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  const f: Record<string, string> = {}
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":")
    if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!f.name || !f.description || !(TYPES as readonly string[]).includes(f.type)) return undefined
  return { name: f.name, description: f.description, type: f.type as MemoryType, body: m[2].trim() }
}

export function indexLine(m: Memory, file: string): string {
  return `- [${oneLine(m.name)}](${file}) — ${oneLine(m.description)}`
}

const lineFile = (line: string) => /^- \[[^\]]*\]\(([^)]+)\)/.exec(line)?.[1]

// Replaces the line of `file` in place, or appends it.
export function upsertIndex(index: string, file: string, line: string): string {
  const lines = index.split("\n").filter((l) => l.trim() !== "")
  const at = lines.findIndex((l) => lineFile(l) === file)
  if (at >= 0) lines[at] = line
  else lines.push(line)
  return lines.join("\n") + "\n"
}

export function removeFromIndex(index: string, file: string): string {
  const lines = index.split("\n").filter((l) => l.trim() !== "" && lineFile(l) !== file)
  return lines.length ? lines.join("\n") + "\n" : ""
}

export function indexMessage(global: string, project: string): string | undefined {
  const parts = [
    global.trim() && `Global memories (~/.pi/agent/memory/):\n${global.trim()}`,
    project.trim() && `Project memories (.pi/memory/):\n${project.trim()}`,
  ].filter(Boolean)
  if (!parts.length) return undefined
  return `<memory>\nIndex of what you saved in earlier sessions. Read a file with the read tool when its line is relevant.\n\n${parts.join("\n\n")}\n</memory>`
}

export const SAVE_NUDGE =
  "The context will be compacted soon. Before it is, save anything worth keeping for later sessions " +
  "with memory_save (one fact per memory: who the user is, what they corrected, project facts, where things live). " +
  "Skip what the code or git history already shows. If there is nothing, reply \"nothing to save\"."
