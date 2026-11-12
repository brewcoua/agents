import { type ChildProcess, spawn } from "node:child_process"
import { Parser, type Diagnostic, fileUri, frame } from "./lsp.ts"

type Waiter = { resolve: (d: Diagnostic[] | undefined) => void; timer: NodeJS.Timeout }

// One language server process over stdio.
export class Client {
  private proc: ChildProcess
  private parser = new Parser()
  private nextId = 1
  private pending = new Map<number, (r: any) => void>()
  private versions = new Map<string, number>()
  private diags = new Map<string, Diagnostic[]>()
  private waiters = new Map<string, Waiter>()
  private ready: Promise<boolean>
  private root: string
  dead = false
  // Set by the first publishDiagnostics: the server is up and indexed.
  warm = false

  constructor(cmd: string[], root: string) {
    this.root = root
    this.proc = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ["pipe", "pipe", "ignore"] })
    this.proc.on("error", () => this.die())
    this.proc.on("exit", () => this.die())
    this.proc.stdin!.on("error", () => {})
    this.proc.stdout!.on("data", (c: Buffer) => this.parser.push(c).forEach((m) => this.onMessage(m as any)))
    this.ready = this.initialize()
  }

  private die() {
    this.dead = true
    for (const r of this.pending.values()) r(undefined)
    this.pending.clear()
    for (const w of this.waiters.values()) w.resolve(undefined)
  }

  private send(msg: unknown) {
    if (!this.dead) this.proc.stdin!.write(frame(msg))
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((res) => {
      this.pending.set(id, res)
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params })
  }

  private onMessage(m: { id?: number; method?: string; params?: any; result?: any }) {
    if (m.method === "textDocument/publishDiagnostics") {
      const { uri, diagnostics } = m.params
      this.warm = true
      this.diags.set(uri, diagnostics)
      const w = this.waiters.get(uri)
      if (w) {
        // Servers often publish twice in a row (syntax, then semantic): take the last of a burst.
        clearTimeout(w.timer)
        w.timer = setTimeout(() => w.resolve(this.diags.get(uri)), 300)
      }
    } else if (m.method !== undefined && m.id !== undefined) {
      // A server-initiated request (workspace/configuration, client/registerCapability ...): answer null.
      this.send({ jsonrpc: "2.0", id: m.id, result: m.method === "workspace/configuration" ? [] : null })
    } else if (m.id !== undefined) {
      this.pending.get(m.id)?.(m.result)
      this.pending.delete(m.id)
    }
  }

  private async initialize(): Promise<boolean> {
    const r = await this.request("initialize", {
      processId: process.pid,
      rootUri: fileUri(this.root),
      workspaceFolders: [{ uri: fileUri(this.root), name: "root" }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: true },
      },
    })
    if (r === undefined) return false
    this.notify("initialized", {})
    return true
  }

  // Sync the file and wait up to timeoutMs for diagnostics; undefined means none arrived.
  async check(path: string, languageId: string, text: string, timeoutMs: number): Promise<Diagnostic[] | undefined> {
    const deadline = Date.now() + timeoutMs
    const init = await Promise.race([this.ready, new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))])
    if (!init || this.dead) return undefined
    const uri = fileUri(path)
    const version = (this.versions.get(uri) ?? 0) + 1
    const result = new Promise<Diagnostic[] | undefined>((res) => {
      const timer = setTimeout(() => {
        this.waiters.delete(uri)
        res(undefined)
      }, Math.max(deadline - Date.now(), 1))
      this.waiters.set(uri, {
        timer,
        resolve: (d) => {
          clearTimeout(timer)
          this.waiters.delete(uri)
          res(d)
        },
      })
    })
    if (version === 1) {
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } })
    } else {
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
    }
    this.versions.set(uri, version)
    this.notify("textDocument/didSave", { textDocument: { uri }, text })
    return result
  }

  async stop() {
    if (this.dead) return
    await Promise.race([this.request("shutdown", null), new Promise((r) => setTimeout(r, 1000))])
    this.notify("exit", null)
    setTimeout(() => this.proc.kill(), 500).unref()
  }
}
