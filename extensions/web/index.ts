import { execFile } from "node:child_process"
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type Result, formatResults, page, title, toText } from "./html.ts"

// The searxng module's socket. The first search after an idle stop starts the container, about a
// second; the first one ever also pulls the image, hence the long timeout.
const SEARXNG = "http://127.0.0.1:8888"
const SEARCH_TIMEOUT = 120_000
const FETCH_TIMEOUT = 30_000
const RENDER_TIMEOUT = 60_000
const MAX_CHARS = 20_000
// A response body larger than this is refused, text or file: it would fill /tmp or the context.
const MAX_BYTES = 50 * 1024 * 1024
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

// Headless chromium without the requests it makes on its own (updates, sync, metrics).
const CHROMIUM = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-extensions",
  "--metrics-recording-only",
  "--no-pings",
  "--hide-scrollbars",
]

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} })

function signalWith(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

function httpUrl(url: string): URL {
  const u = new URL(url)
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`not an http(s) URL: ${url}`)
  return u
}

function windowed(text: string, offset: number, head: string): string {
  const w = page(text, offset, MAX_CHARS)
  const more = w.next === undefined ? "" : `\n\n[${text.length - w.next} more characters: call again with offset ${w.next}]`
  return `${head}\n\n${w.text}${more}`
}

async function body(res: Response): Promise<Buffer> {
  const too = () => new Error(`${res.url} is larger than ${MAX_BYTES / 1024 / 1024} MB`)
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw too()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    size += chunk.length
    if (size > MAX_BYTES) throw too()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return join(dir, cmd)
    } catch {}
  }
  return undefined
}

function run(cmd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { signal, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, out, errOut) =>
      err ? reject(new Error(`${cmd} failed: ${errOut.trim().split("\n").pop() || err.message}`)) : resolve(out),
    ),
  )
}

export default function (pi: ExtensionAPI) {
  // Files web_fetch saves live as long as the session, so the model can read them meanwhile.
  let downloads: string | undefined
  pi.on("session_shutdown", () => {
    if (downloads) rmSync(downloads, { recursive: true, force: true })
    downloads = undefined
  })

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web through the local SearXNG. Returns titles, URLs and snippets; read a page with web_fetch. " +
      "Use it for anything newer than your training or specific to a version, and cite the URLs you use.",
    promptSnippet: "Search the web (local SearXNG)",
    parameters: Type.Object({
      query: Type.String(),
      category: Type.Optional(
        Type.Union([Type.Literal("general"), Type.Literal("it"), Type.Literal("news"), Type.Literal("science")], {
          description: "it searches code hosts, package registries and Q&A sites; default general",
        }),
      ),
      engines: Type.Optional(
        Type.String({
          description:
            "Comma-separated engine names to search instead of the category, including these, off by default: " +
            "google, qwant, yahoo, yandex, mwmbl, wiby, gitlab, codeberg, sourcehut, discuss.python, microsoft learn, nixos wiki, " +
            "lib.rs, packagist, pub.dev, hex, hoogle, huggingface, alpine linux packages, voidlinux, fdroid, " +
            "free software directory, national vulnerability database, crossref, google scholar, google news, qwant news",
        }),
      ),
      max: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Results to return, default 8" })),
    }),
    async execute(_id, p, signal) {
      const u = new URL("/search", SEARXNG)
      // SearXNG ignores engines when categories is also set.
      const where: Record<string, string> = p.engines ? { engines: p.engines } : { categories: p.category ?? "general" }
      u.search = new URLSearchParams({ q: p.query, format: "json", ...where }).toString()
      let res: Response
      try {
        res = await fetch(u, { signal: signalWith(signal, SEARCH_TIMEOUT) })
      } catch (e) {
        const refused = (e as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED"
        throw new Error(refused ? "SearXNG is not running. Run: othala module add searxng, or othala module start searxng if it is added" : `search failed: ${(e as Error).message}`)
      }
      if (!res.ok) throw new Error(`SearXNG answered ${res.status} ${res.statusText}`)
      const data = (await res.json()) as { results: Result[]; unresponsive_engines?: [string, string][] }
      const down = data.unresponsive_engines?.length ? `\n\nNo answer from: ${data.unresponsive_engines.map(([e, why]) => `${e} (${why})`).join(", ")}` : ""
      return ok(formatResults(data.results, p.max ?? 8) + down)
    },
  })

  pi.registerTool({
    name: "web_fetch",
    label: "Fetch page",
    description:
      "Fetch a URL and return its text. HTML comes back as Markdown-like text, the main content only when the page marks it. " +
      `Long pages come in windows of ${MAX_CHARS} characters: pass offset to read on. ` +
      "A PDF or other binary file is saved to a temporary path, which is returned. " +
      "A page that builds its content with JavaScript comes back nearly empty: use web_render for it.",
    promptSnippet: "Fetch a URL as text",
    parameters: Type.Object({
      url: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to start from, for long pages" })),
      raw: Type.Optional(Type.Boolean({ description: "Return the HTML source instead of text" })),
    }),
    async execute(_id, p, signal) {
      const url = httpUrl(p.url)
      const res = await fetch(url, { signal: signalWith(signal, FETCH_TIMEOUT), headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${res.url}`)
      const type = res.headers.get("content-type") ?? ""
      const head = `${res.url}\n${type}`
      const data = await body(res)
      if (/^text\/html|xhtml/i.test(type) && !p.raw) {
        const html = data.toString("utf8")
        return ok(windowed(toText(html, res.url), p.offset ?? 0, `${title(html)}\n${head}`))
      }
      if (/^text\/|json|xml|javascript|yaml/i.test(type)) return ok(windowed(data.toString("utf8"), p.offset ?? 0, head))
      downloads ??= mkdtempSync(join(tmpdir(), "pi-web-"))
      const name = decodeURIComponent(new URL(res.url).pathname.split("/").pop() || "download")
      const file = join(mkdtempSync(join(downloads, "f-")), name.replace(/[^\w.-]/g, "_"))
      writeFileSync(file, data)
      return ok(`${head}\nNot text; saved to ${file}`)
    },
  })

  // Fedora's package installs chromium-browser.
  const chromium = which("chromium") ?? which("chromium-browser")
  if (!chromium) return

  pi.registerTool({
    name: "web_render",
    label: "Render page",
    description:
      "Load a URL in headless chromium, run its JavaScript, and return the text of the result, or a screenshot. " +
      "Slower than web_fetch: use it when web_fetch returns a nearly empty page, or to see how a page looks. " +
      "It does not click, type or log in.",
    promptSnippet: "Render a URL in headless chromium (text or screenshot)",
    parameters: Type.Object({
      url: Type.String(),
      screenshot: Type.Optional(Type.Boolean({ description: "Return a PNG of the page instead of its text" })),
      width: Type.Optional(Type.Integer({ minimum: 320, maximum: 3840, description: "Viewport width, default 1280" })),
      height: Type.Optional(Type.Integer({ minimum: 240, maximum: 8000, description: "Viewport height, and so how much of the page a screenshot shows; default 1600" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to start from, for long pages" })),
    }),
    async execute(_id, p, signal) {
      const url = httpUrl(p.url).href
      const profile = mkdtempSync(join(tmpdir(), "pi-chromium-"))
      try {
        const args = [...CHROMIUM, `--user-data-dir=${profile}`, `--window-size=${p.width ?? 1280},${p.height ?? 1600}`, "--virtual-time-budget=10000"]
        const sig = signalWith(signal, RENDER_TIMEOUT)
        if (p.screenshot) {
          const png = join(profile, "page.png")
          await run(chromium, [...args, `--screenshot=${png}`, url], sig)
          return { content: [{ type: "image" as const, data: readFileSync(png).toString("base64"), mimeType: "image/png" }], details: {} }
        }
        const html = await run(chromium, [...args, "--dump-dom", url], sig)
        return ok(windowed(toText(html, url), p.offset ?? 0, `${title(html)}\n${url}`))
      } finally {
        rmSync(profile, { recursive: true, force: true })
      }
    },
  })
}
