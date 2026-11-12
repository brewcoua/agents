import { dirname, extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type Diagnostic = {
  range: { start: { line: number; character: number } }
  severity?: number // 1 error, 2 warning, 3 info, 4 hint
  message: string
  source?: string
  code?: string | number
}

export type Server = {
  cmd: string[]
  // Files or directories that mark a workspace root, nearest ancestor wins.
  roots: string[]
  // extension -> languageId
  langs: Record<string, string>
}

// The set modules/tools/nvim enables (bashls, clangd, gopls, lua_ls, pyright, rust_analyzer, ts_ls).
export const SERVERS: Record<string, Server> = {
  "rust-analyzer": { cmd: ["rust-analyzer"], roots: ["Cargo.toml"], langs: { ".rs": "rust" } },
  "lua-language-server": { cmd: ["lua-language-server"], roots: [".luarc.json", ".luarc.jsonc", ".git"], langs: { ".lua": "lua" } },
  pyright: {
    cmd: ["pyright-langserver", "--stdio"],
    roots: ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt", ".git"],
    langs: { ".py": "python" },
  },
  basedpyright: {
    cmd: ["basedpyright-langserver", "--stdio"],
    roots: ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt", ".git"],
    langs: { ".py": "python" },
  },
  "typescript-language-server": {
    cmd: ["typescript-language-server", "--stdio"],
    roots: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    langs: {
      ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
      ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
    },
  },
  gopls: { cmd: ["gopls"], roots: ["go.work", "go.mod"], langs: { ".go": "go" } },
  clangd: {
    cmd: ["clangd"],
    roots: ["compile_commands.json", ".clangd", "CMakeLists.txt", ".git"],
    langs: { ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp" },
  },
  "bash-language-server": {
    cmd: ["bash-language-server", "start"],
    roots: [".git"],
    langs: { ".sh": "shellscript", ".bash": "shellscript" },
  },
}

// Candidates for an extension, in preference order (pyright before basedpyright).
export function candidates(path: string): string[] {
  const ext = extname(path)
  return Object.keys(SERVERS).filter((n) => ext in SERVERS[n].langs)
}

export function findRoot(file: string, markers: string[], exists: (p: string) => boolean): string {
  let dir = dirname(resolve(file))
  for (;;) {
    if (markers.some((m) => exists(join(dir, m)))) return dir
    const up = dirname(dir)
    if (up === dir) return dirname(resolve(file))
    dir = up
  }
}

export const fileUri = (p: string) => pathToFileURL(p).href

export function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

// Content-Length framing: feed chunks, get whole messages back.
export class Parser {
  private buf = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: unknown[] = []
    for (;;) {
      const end = this.buf.indexOf("\r\n\r\n")
      if (end < 0) break
      const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString("ascii"))
      if (!m) {
        this.buf = this.buf.subarray(end + 4) // a header block we cannot use
        continue
      }
      const start = end + 4
      const len = Number(m[1])
      if (this.buf.length < start + len) break
      try {
        out.push(JSON.parse(this.buf.subarray(start, start + len).toString("utf8")))
      } catch {}
      this.buf = this.buf.subarray(start + len)
    }
    return out
  }
}

const SEVERITY = ["", "error", "warning", "info", "hint"]

// Errors first, then up to maxWarnings warnings. Info and hints are dropped.
export function formatDiagnostics(file: string, diags: Diagnostic[], maxErrors = 20, maxWarnings = 5): string {
  const at = (d: Diagnostic) => d.range.start.line * 1e6 + d.range.start.character
  const sev = (d: Diagnostic) => d.severity ?? 1
  const errors = diags.filter((d) => sev(d) === 1).sort((a, b) => at(a) - at(b))
  const warnings = diags.filter((d) => sev(d) === 2).sort((a, b) => at(a) - at(b))
  if (!errors.length && !warnings.length) return ""
  const line = (d: Diagnostic) => {
    const src = d.source ? ` [${d.source}${d.code !== undefined ? ` ${d.code}` : ""}]` : ""
    const msg = d.message.split("\n")[0]
    return `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[sev(d)]}: ${msg}${src}`
  }
  const out = [`LSP diagnostics for ${file}: ${errors.length} error(s), ${warnings.length} warning(s)`]
  out.push(...errors.slice(0, maxErrors).map(line))
  out.push(...warnings.slice(0, maxWarnings).map(line))
  const hidden = Math.max(0, errors.length - maxErrors) + Math.max(0, warnings.length - maxWarnings)
  if (hidden) out.push(`  ... ${hidden} more not shown`)
  return out.join("\n")
}
