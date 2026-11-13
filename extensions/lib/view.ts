// The dashboards' screen: a list, and a scrollable detail page per row. Not an extension: Pi
// loads only extensions/*/index.ts, and this directory has none.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"

export type Row = {
  label: string
  dim?: boolean
  detail?: () => string // Enter shows it
}

// A key acting on the selected row. `confirm` asks for the same key a second time.
export type Action = { key: string; label: string; confirm?: boolean; run: (row: Row, index: number) => void | Promise<void> }

export type ListOptions = {
  title: string
  rows: () => Row[] // read again on each refresh and after each action
  empty: string
  actions?: Action[]
  refreshMs?: number // for live state, such as a task run
}

export async function showList(ctx: ExtensionCommandContext, o: ListOptions): Promise<void> {
  if (ctx.mode !== "tui") {
    const rows = o.rows()
    return ctx.ui.notify(rows.length ? `${o.title}\n${rows.map((r) => `- ${r.label}`).join("\n")}` : o.empty, "info")
  }
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let rows = o.rows()
    let at = 0
    let detail: string[] | undefined // wrapped lines of the open detail page
    let top = 0
    let pending: string | undefined // an action key waiting for its confirmation
    let note = ""
    const height = () => Math.max(5, (process.stdout.rows ?? 24) - 8)
    const reload = () => {
      rows = o.rows()
      at = Math.min(at, Math.max(0, rows.length - 1))
    }
    const timer = o.refreshMs ? setInterval(() => (reload(), tui.requestRender()), o.refreshMs) : undefined
    const close = () => {
      if (timer) clearInterval(timer)
      done()
    }
    const rule = (width: number, title: string) => {
      const head = `─── ${title} `
      return truncateToWidth(theme.fg("accent", head) + theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(head)))), width)
    }

    return {
      render(width: number): string[] {
        const out = [rule(width, o.title)]
        if (detail) {
          const page = detail.slice(top, top + height())
          out.push(...page.map((l) => truncateToWidth(` ${l}`, width)))
          out.push(theme.fg("dim", truncateToWidth(` ${top + page.length}/${detail.length}  j/k scroll  esc back`, width)))
          return out
        }
        if (!rows.length) out.push(theme.fg("dim", truncateToWidth(` ${o.empty}`, width)))
        const h = height()
        const first = Math.max(0, Math.min(at - Math.floor(h / 2), rows.length - h))
        rows.slice(first, first + h).forEach((r, i) => {
          const sel = first + i === at
          const text = `${sel ? ">" : " "} ${r.label}`
          out.push(truncateToWidth(sel ? theme.fg("accent", text) : r.dim ? theme.fg("dim", text) : text, width))
        })
        const keys = ["j/k move", ...(rows[at]?.detail ? ["enter open"] : []), ...(o.actions ?? []).map((a) => `${a.key} ${a.label}`), "esc close"]
        out.push(theme.fg("dim", truncateToWidth(` ${note || keys.join("  ")}`, width)))
        return out
      },
      handleInput(data: string) {
        note = ""
        if (detail) {
          if (matchesKey(data, "escape") || data === "q") detail = undefined
          else if (matchesKey(data, "down") || data === "j") top = Math.min(top + 1, Math.max(0, detail.length - height()))
          else if (matchesKey(data, "up") || data === "k") top = Math.max(0, top - 1)
          else if (data === " " || matchesKey(data, "pageDown")) top = Math.min(top + height(), Math.max(0, detail.length - height()))
          else if (matchesKey(data, "pageUp")) top = Math.max(0, top - height())
          return tui.requestRender()
        }
        if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) return close()
        if (matchesKey(data, "down") || data === "j") at = Math.min(at + 1, Math.max(0, rows.length - 1))
        else if (matchesKey(data, "up") || data === "k") at = Math.max(0, at - 1)
        else if (matchesKey(data, "enter") && rows[at]?.detail) {
          detail = (rows[at].detail as () => string)().split("\n").flatMap((l) => wrapTextWithAnsi(l, Math.max(20, (process.stdout.columns ?? 80) - 2)))
          top = 0
        } else {
          const a = (o.actions ?? []).find((x) => x.key === data)
          if (a && rows[at]) {
            if (a.confirm && pending !== a.key) {
              pending = a.key
              note = `press ${a.key} again to ${a.label}`
              return tui.requestRender()
            }
            pending = undefined
            void Promise.resolve(a.run(rows[at], at)).then(
              () => (reload(), tui.requestRender()),
              (e) => ((note = `${a.label}: ${e instanceof Error ? e.message : e}`), tui.requestRender()),
            )
          }
        }
        pending = undefined
        tui.requestRender()
      },
      invalidate() {},
    }
  })
}
