// Pure logic of the btw extension: no Pi imports, so node --test runs it.

export const READ_ONLY = ["read", "grep", "find", "ls"]

export const SYSTEM = [
  "You answer one quick side question while the main agent works on something else.",
  "You have read-only tools. Change nothing. Answer briefly; say so when you cannot tell.",
].join(" ")

// The text after `/btw`, or undefined when there is no question.
export function parseArgs(args: string): string | undefined {
  const q = args.trim()
  return q === "" ? undefined : q
}

export function onlyReadOnly(names: string[]): string[] {
  return names.filter((n) => READ_ONLY.includes(n))
}

type Entry = { type?: string; message?: { role?: string; content?: unknown } }

// The user and assistant text of the main session, newest `max` characters.
// Tool calls and results are left out: the side session has its own tools.
export function transcript(entries: Entry[], max: number): string {
  const lines: string[] = []
  for (const { type, message } of entries) {
    if (type !== "message" || (message?.role !== "user" && message?.role !== "assistant")) continue
    const c = message.content
    const text = (
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.flatMap((p) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n")
          : ""
    ).trim()
    if (text) lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`)
  }
  const all = lines.join("\n\n")
  return all.length > max ? all.slice(all.length - max) : all
}
