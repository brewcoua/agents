import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Client } from "../home/.pi/agent/extensions/lsp/client.ts"
import { Parser, SERVERS, candidates, findRoot, formatDiagnostics, frame } from "../home/.pi/agent/extensions/lsp/lsp.ts"

const d = (line: number, severity: number, message: string, source?: string) => ({
  range: { start: { line, character: 2 } },
  severity,
  message,
  source,
})

test("framing: encode, split chunks, several messages, multibyte body", () => {
  const a = frame({ id: 1, text: "héllo" })
  const b = frame({ id: 2 })
  assert.equal(a.subarray(0, 20).toString().startsWith("Content-Length: "), true)
  const all = Buffer.concat([a, b])
  const p = new Parser()
  const out: unknown[] = []
  for (let i = 0; i < all.length; i += 7) out.push(...p.push(all.subarray(i, i + 7)))
  assert.deepEqual(out, [{ id: 1, text: "héllo" }, { id: 2 }])
})

test("framing: extra headers and a header block without length are skipped", () => {
  const body = Buffer.from('{"ok":true}')
  const raw = Buffer.concat([
    Buffer.from("X: y\r\n\r\n"),
    Buffer.from(`Content-Type: utf-8\r\ncontent-length: ${body.length}\r\n\r\n`),
    body,
  ])
  assert.deepEqual(new Parser().push(raw), [{ ok: true }])
})

test("diagnostics: errors first, warnings capped, info dropped, 1-based positions", () => {
  const out = formatDiagnostics(
    "a.rs",
    [d(9, 2, "w1"), d(4, 1, "e2\nsecond line", "rustc"), d(1, 1, "e1"), d(3, 3, "i"), d(5, 2, "w2"), d(6, 2, "w3")],
    20,
    2,
  )
  assert.equal(
    out,
    [
      "LSP diagnostics for a.rs: 2 error(s), 3 warning(s)",
      "  2:3 error: e1",
      "  5:3 error: e2 [rustc]",
      "  6:3 warning: w2",
      "  7:3 warning: w3",
      "  ... 1 more not shown",
    ].join("\n"),
  )
  assert.equal(formatDiagnostics("a.rs", [d(0, 3, "i"), d(0, 4, "h")]), "")
  assert.equal(formatDiagnostics("a.rs", []), "")
})

test("servers: extension table and root search", () => {
  assert.deepEqual(candidates("/x/a.py"), ["pyright", "basedpyright"])
  assert.deepEqual(candidates("/x/a.rs"), ["rust-analyzer"])
  assert.deepEqual(candidates("/x/a.md"), [])
  assert.ok(SERVERS.gopls)
  const has = new Set(["/p/Cargo.toml", "/p/sub/Cargo.toml"])
  const ex = (p: string) => has.has(p)
  assert.equal(findRoot("/p/sub/src/a.rs", ["Cargo.toml"], ex), "/p/sub")
  assert.equal(findRoot("/q/a.rs", ["Cargo.toml"], ex), "/q")
})

const have = (c: string) => {
  try {
    execFileSync("which", [c], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

test("round trip with lua-language-server, when installed", { skip: !have("lua-language-server") }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lsp-"))
  const file = join(dir, "a.lua")
  const c = new Client(["lua-language-server"], dir)
  try {
    writeFileSync(file, "local x = = 1\n")
    const bad = await c.check(file, "lua", "local x = = 1\n", 20000)
    assert.ok(bad && bad.some((x) => x.severity === 1), JSON.stringify(bad))
    assert.match(formatDiagnostics("a.lua", bad), /error/)
    const good = await c.check(file, "lua", "local x = 1\nreturn x\n", 20000)
    assert.ok(good && !good.some((x) => x.severity === 1), JSON.stringify(good))
  } finally {
    await c.stop()
  }
})
