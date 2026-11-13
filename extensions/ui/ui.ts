import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export type Tone = "success" | "warning" | "error" | undefined

// Under half is fine, from 70% it is worth a look, from 90% it is about to stop something.
export const tone = (pct: number): Tone => (pct >= 90 ? "error" : pct >= 70 ? "warning" : pct < 50 ? "success" : undefined)

// Colours every `N%` in a status by its tone; the rest of the text is left as it is.
export const tint = (text: string, fg: (tone: NonNullable<Tone>, s: string) => string) =>
  text.replace(/\d+(?:\.\d+)?%/g, (m) => {
    const t = tone(Number.parseFloat(m))
    return t ? fg(t, m) : m
  })

// Statuses that change what the session may do come first; the rest in the order they were set.
const FIRST = ["plan", "tasks"]
export const orderStatuses = (statuses: ReadonlyMap<string, string>) =>
  [...statuses].sort(([a], [b]) => (FIRST.indexOf(a) + 1 || 99) - (FIRST.indexOf(b) + 1 || 99))

// One line: the left parts joined by `sep`, the right part flush right. Left parts are dropped
// from the end until the line fits; the right part is cut last.
export function line(left: string[], right: string, width: number, sep: string): string {
  const parts = [...left]
  const gap = 2
  const join = () => parts.join(sep)
  while (parts.length > 1 && visibleWidth(join()) + gap + visibleWidth(right) > width) parts.pop()
  const l = join()
  const room = width - visibleWidth(l) - gap
  if (room < 1) return truncateToWidth(l, width)
  const r = truncateToWidth(right, room, "…")
  return l + " ".repeat(width - visibleWidth(l) - visibleWidth(r)) + r
}
