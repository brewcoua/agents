import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type Memory, SAVE_NUDGE, TYPES, format, indexLine, indexMessage, removeFromIndex, slug, upsertIndex } from "./memory.ts"

// Context usage (percent of the window) from which the model is asked to save
// before Pi compacts. Pi compacts near the end of the window, so this leaves room for one turn.
const NUDGE_AT = 80

const INDEX = "MEMORY.md"
const dirs = (cwd: string) => ({
  global: join(homedir(), ".pi", "agent", "memory"),
  project: join(cwd, ".pi", "memory"),
})

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} })

export default function (pi: ExtensionAPI) {
  let injected: string | undefined
  let nudged = false

  const load = (cwd: string) => {
    const d = dirs(cwd)
    injected = indexMessage(readFile(join(d.global, INDEX)), readFile(join(d.project, INDEX)))
  }
  pi.on("session_start", (_e, ctx) => load(ctx.cwd))
  pi.on("session_compact", (_e, ctx) => {
    nudged = false
    load(ctx.cwd)
  })

  // Not a stored message: the index is prepended for each request, so it never
  // piles up in the session, and a compaction cannot summarize it away.
  pi.on("context", (event) => {
    if (!injected) return undefined
    const index = { role: "user" as const, content: [{ type: "text" as const, text: injected }], timestamp: 0 }
    return { messages: [index, ...event.messages] }
  })

  // Pi gives no hook that can add a turn or text to a compaction: session_before_compact
  // only cancels or replaces the summary, which would be an LLM call of our own. So ask
  // earlier, once per compaction cycle, when the run ends near the threshold.
  pi.on("agent_before_settle", (event, ctx) => {
    const percent = ctx.getContextUsage()?.percent
    if (nudged || event.outcome !== "completed" || percent == null || percent < NUDGE_AT) return undefined
    nudged = true
    return { entries: [{ type: "custom_message", customType: "memory", content: SAVE_NUDGE, display: false }], continue: true }
  })

  pi.registerTool({
    name: "memory_save",
    label: "Save memory",
    description:
      "Create or update one memory: a single fact worth keeping across sessions. Same name replaces the memory. " +
      "scope 'global' is about the user in any project; 'project' is about this project.",
    promptSnippet: "Save a fact for later sessions (one fact per memory)",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
      name: Type.String({ description: "Short title, unique within the scope" }),
      description: Type.String({ description: "One line, what the memory says; shown in the index" }),
      type: Type.Union(TYPES.map((t) => Type.Literal(t)), {
        description: "user: who the user is; feedback: a correction or confirmed approach; project: facts about the work; reference: where things live",
      }),
      body: Type.String({ description: "The fact, with why it matters" }),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const file = `${slug(p.name)}.md`
      if (file === ".md") throw new Error("name has no letters or digits")
      const dir = dirs(ctx.cwd)[p.scope]
      const m: Memory = { name: p.name, description: p.description, type: p.type, body: p.body }
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, file), format(m))
      writeFileSync(join(dir, INDEX), upsertIndex(readFile(join(dir, INDEX)), file, indexLine(m, file)))
      return ok(`Saved ${p.scope}/${file}`)
    },
  })

  pi.registerTool({
    name: "memory_forget",
    label: "Forget memory",
    description: "Delete one memory and its index line. Use it for a memory that is wrong or no longer true.",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
      name: Type.String({ description: "The name the memory was saved under" }),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const file = `${slug(p.name)}.md`
      const dir = dirs(ctx.cwd)[p.scope]
      mkdirSync(dir, { recursive: true })
      rmSync(join(dir, file), { force: true })
      writeFileSync(join(dir, INDEX), removeFromIndex(readFile(join(dir, INDEX)), file))
      return ok(`Forgot ${p.scope}/${file}`)
    },
  })
}
