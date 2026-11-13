import { basename } from "node:path"
import { type ExtensionAPI, type ExtensionContext, VERSION, getAgentDir } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import { loadActive } from "../lib/profiles.ts"
import { line, orderStatuses, tint } from "./ui.ts"

export default function (pi: ExtensionAPI) {
  let profile = ""
  const readProfile = () => {
    profile = loadActive(getAgentDir()).profile
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return
    readProfile()

    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number) => {
        const skills = pi.getCommands().filter((c) => c.source === "skill").length
        const hints = ["/ commands", "! bash", "esc interrupt", "ctrl+c clear", "ctrl+d exit"].join(theme.fg("borderMuted", " · "))
        return [truncateToWidth(`${theme.fg("accent", "pi")} ${theme.fg("dim", VERSION)}  ${theme.fg("muted", `${skills} skills`)}  ${theme.fg("dim", hints)}`, width), ""]
      },
      invalidate() {},
    }))

    ctx.ui.setFooter((tui, theme, data) => {
      const stop = data.onBranchChange(() => tui.requestRender())
      return {
        render(width: number): string[] {
          const sep = theme.fg("borderMuted", " │ ")
          const branch = data.getGitBranch()
          const where = theme.fg("accent", basename(ctx.cwd)) + (branch ? ` ${theme.fg("muted", branch)}` : "")
          const pct = ctx.getContextUsage()?.percent
          const left = [where, ...(pct == null ? [] : [`ctx ${Math.round(pct)}%`])]
          for (const [key, text] of orderStatuses(data.getExtensionStatuses())) left.push(key === "plan" ? theme.fg("warning", text) : text)
          const model = ctx.model
          const right = model
            ? theme.fg("accent", model.id) + (model.reasoning ? theme.fg("muted", ` · ${pi.getThinkingLevel()}`) : "") + theme.fg("dim", `  ${profile}`)
            : theme.fg("warning", "no model")
          const tinted = left.map((p, i) => (i === 0 ? p : tint(p, (t, s) => theme.fg(t, s))))
          return [line(tinted, right, width, sep)]
        },
        invalidate() {},
        dispose: stop,
      }
    })
  }

  pi.on("session_start", (_e, ctx) => install(ctx))
  // /provider switches through setModel, so a new model may mean a new profile.
  pi.on("model_select", () => readProfile())
}
