import { accessSync, readFileSync } from "node:fs"
import { delimiter, extname, join, resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Client } from "./client.ts"
import { SERVERS, candidates, findRoot, formatDiagnostics } from "./lsp.ts"

// rust-analyzer needs most of this on a cold start; the others answer well inside it.
const TIMEOUT_MS = Number(process.env.OTHALA_LSP_TIMEOUT_MS) || 10000
// Once a server has published, silence means a clean file for servers that skip empty
// publishes (lua-language-server), so later edits do not wait the full time.
const WARM_TIMEOUT_MS = 2000

const onPath = (cmd: string) =>
  (process.env.PATH ?? "").split(delimiter).some((d) => {
    try {
      accessSync(join(d, cmd))
      return true
    } catch {
      return false
    }
  })

const exists = (p: string) => {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}

export default function (pi: ExtensionAPI) {
  const clients = new Map<string, Client>() // "<server>\0<root>"

  pi.on("session_shutdown", async () => {
    await Promise.all([...clients.values()].map((c) => c.stop()))
    clients.clear()
  })

  pi.on("tool_result", async (event, ctx) => {
    if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError) return undefined
    const raw = String(event.input.path ?? event.input.file_path ?? "")
    if (!raw) return undefined
    const path = resolve(ctx.cwd, raw)
    const name = candidates(path).find((n) => onPath(SERVERS[n].cmd[0]))
    if (!name) return undefined
    const server = SERVERS[name]

    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      return undefined
    }
    const root = findRoot(path, server.roots, exists)
    const key = `${name}\0${root}`
    let client = clients.get(key)
    if (!client || client.dead) {
      client = new Client(server.cmd, root)
      clients.set(key, client)
    }
    const warm = client.warm
    const diags = await client.check(path, server.langs[extname(path)], text, warm ? WARM_TIMEOUT_MS : TIMEOUT_MS)
    if (diags === undefined && warm) return undefined
    const note =
      diags === undefined
        ? `LSP (${name}): no diagnostics yet for ${raw}; the server did not answer in ${TIMEOUT_MS / 1000}s.`
        : formatDiagnostics(raw, diags)
    if (!note) return undefined
    return { content: [...event.content, { type: "text" as const, text: `\n${note}` }] }
  })
}
