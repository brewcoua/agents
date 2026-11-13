// HTML to readable text, close to Markdown: headings, links, lists and code survive, the rest is
// paragraphs. Not a parser: it is for a model to read the page, not to rebuild it.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" }

export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

// Entities stay encoded until the end of toText, which decodes once.
const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()

export function title(html: string): string {
  return decode(strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""))
}

export function toText(html: string, base?: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, "")
  // <main> or <article> when the page has one: navigation and footers are noise.
  const main = /<main\b[\s\S]*<\/main>/i.exec(s) ?? /<article\b[\s\S]*<\/article>/i.exec(s)
  if (main) s = main[0]
  s = s
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c: string) => `\n\n\`\`\`\n${decode(c.replace(/<[^>]*>/g, "")).replace(/^\n+|\s+$/g, "")}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, c: string) => `\`${strip(c)}\``)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, c: string) => `\n\n${"#".repeat(Number(n))} ${strip(c)}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href: string, c: string) => {
      const text = strip(c)
      const url = /^\s*(#|javascript:)/i.test(href) ? undefined : absolute(decode(href), base)
      return !text ? "" : url ? `[${text}](${url})` : text
    })
    .replace(/<img\b[^>]*?alt\s*=\s*(["'])(.+?)\1[^>]*>/gi, (_m, _q, alt: string) => `[image: ${alt}]`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>\s*/gi, (_m, row: string) => {
      const cells = [...row.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => strip(c[2]))
      return `\n| ${cells.join(" | ")} |`
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|header|footer|nav|aside|ul|ol|table|tr|blockquote|dl|dt|dd|figure|form)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
  // Collapse spaces outside code blocks only.
  return s
    .split(/(```\n[\s\S]*?\n```)/)
    .map((part, i) => (i % 2 ? part : decode(part).replace(/¶/g, "").replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/^- *\n+/gm, "- ").replace(/\n{3,}/g, "\n\n")))
    .join("")
    .trim()
}

function absolute(href: string, base?: string): string | undefined {
  try {
    return new URL(href, base).href
  } catch {
    return undefined
  }
}

// One window of a long text; `next` is the offset to pass to read on, if any.
export function page(text: string, offset: number, max: number): { text: string; next?: number } {
  const end = offset + max
  return end < text.length ? { text: text.slice(offset, end), next: end } : { text: text.slice(offset) }
}

export interface Result {
  title: string
  url: string
  content?: string
  engines?: string[]
  publishedDate?: string | null
}

export function formatResults(all: Result[], max: number): string {
  // An engine whose markup changed can return links with no host, which web_fetch cannot open.
  const results = all.filter((r) => /^https?:\/\/[^/]/.test(r.url))
  const dropped = all.length - results.length
  const note = dropped ? `\n\n${dropped} results without a usable URL left out.` : ""
  if (!results.length) return "No results." + note
  return results
    .slice(0, max)
    .map((r, i) => {
      const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : ""
      const snippet = r.content ? `\n   ${r.content.replace(/\s+/g, " ").trim()}` : ""
      return `${i + 1}. ${r.title}${date}\n   ${r.url}${snippet}`
    })
    .join("\n") + note
}
