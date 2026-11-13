import type { Message } from "@earendil-works/pi-ai"
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown, Text, type TUI, matchesKey } from "@earendil-works/pi-tui"
import { edit } from "../lib/editor.ts"
import { showList } from "../lib/view.ts"
import { type Agent, find, live, mention } from "./fleet.ts"
import { Spawner } from "./runtime.ts"
import { type Fg, conversation, fleet, tree, widget } from "./view.ts"

// An agent's transcript, following it. Resolves "steer" when Enter asks for a message to send.
function transcript(ctx: ExtensionContext, spawner: Spawner, a: Agent) {
  return ctx.ui.custom<"steer" | "close">((tui, theme, _kb, done) => {
    const timer = setInterval(() => tui.requestRender(), 200)
    let stopArmed = false
    const close = (r: "steer" | "close") => {
      clearInterval(timer)
      done(r)
    }
    return {
      render(width: number) {
        const border = new DynamicBorder((s: string) => theme.fg("accent", s))
        const keys = [live(a) && "enter steer", live(a) && (stopArmed ? "x again to stop" : "x x stop"), live(a) && !a.background && "b background", "esc close"]
        const body = new Markdown(conversation(spawner.messages(a.id) as Message[]) || " ", 1, 1, getMarkdownTheme())
        // Following: the newest lines, as many as fit with the head and foot.
        const lines = body.render(width).slice(-Math.max(3, Math.floor(tui.terminal.rows * 0.8) - 4))
        const head = new Text(`${theme.fg("accent", theme.bold(a.handle))} ${theme.fg("dim", `${a.type} · ${a.status} · ${a.turns} turns`)}`, 1, 0)
        const foot = new Text(theme.fg("dim", keys.filter(Boolean).join(" · ")), 1, 0)
        return [...border.render(width), ...head.render(width), ...lines, ...foot.render(width), ...border.render(width)]
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, "escape")) return close("close")
        if (!live(a)) return
        if (matchesKey(data, "enter")) return close("steer")
        if (data === "x") {
          if (stopArmed) spawner.stop(a.id)
          stopArmed = !stopArmed
        } else stopArmed = false
        if (data === "b") spawner.background(a)
        tui.requestRender()
      },
    }
  }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } })
}

async function open(ctx: ExtensionContext, spawner: Spawner, a: Agent) {
  while ((await transcript(ctx, spawner, a)) === "steer") {
    const message = (await ctx.ui.input(`steer ${a.handle}`, "Message for the agent"))?.trim()
    if (message) ctx.ui.notify(spawner.steer(a, message), "info")
  }
}

export default function (pi: ExtensionAPI) {
  const spawner = new Spawner(pi)
  for (const t of spawner.tools({ id: "main", depth: 0 })) pi.registerTool(t)

  pi.on("session_start", (_e, ctx) => {
    const { errors } = spawner.bind(ctx)
    if (errors.length) ctx.ui.notify(`agents: skipped\n${errors.join("\n")}`, "warning")
    if (!ctx.hasUI) return
    const fg = (theme: { fg: (c: never, s: string) => string }): Fg => (c, s) => theme.fg(c as never, s)

    // Above the editor while an agent runs: its own timer turns the spinner and picks up tool and
    // token changes. Below it, the fleet, once the session has had an agent.
    let running = false
    let fleetTui: TUI | undefined
    let selected: number | undefined
    let stopArmed = false
    spawner.onRunning = () => {
      if (!fleetTui && spawner.agents.length) {
        ctx.ui.setWidget("agents-fleet", (tui, theme) => {
          fleetTui = tui
          return { render: (width: number) => fleet(spawner.agents, selected, width, fg(theme)), invalidate() {} }
        }, { placement: "belowEditor" })
      }
      fleetTui?.requestRender()
      const now = spawner.agents.some((a) => a.status === "running")
      if (now === running) return
      running = now
      if (!running) return ctx.ui.setWidget("agents", undefined)
      ctx.ui.setWidget("agents", (tui, theme) => {
        let frame = 0
        const timer = setInterval(() => {
          frame++
          tui.requestRender()
        }, 100)
        return { render: (width: number) => widget(spawner.agents, frame, width, fg(theme)), invalidate() {}, dispose: () => clearInterval(timer) }
      })
    }

    // ↓ on an empty prompt gives the fleet the keyboard; ctrl+b backgrounds main's foreground
    // agents, and is the editor's cursor-left otherwise.
    ctx.ui.onTerminalInput((data) => {
      if (selected === undefined) {
        const foreground = spawner.agents.filter((a) => a.parent === "main" && a.status === "running" && !a.background)
        if (matchesKey(data, "ctrl+b") && foreground.length) {
          for (const a of foreground) spawner.background(a)
          return { consume: true }
        }
        // Input comes here before any dialog: only the main editor, empty, gives ↓ away.
        const focused = (fleetTui as unknown as { getFocusedComponent(): { getText?: unknown } | null } | undefined)?.getFocusedComponent()
        const inEditor = fleetTui && !fleetTui.hasOverlay() && typeof focused?.getText === "function"
        if (!matchesKey(data, "down") || !inEditor || ctx.ui.getEditorText() !== "") return undefined
        selected = 0
        fleetTui?.requestRender()
        return { consume: true }
      }
      const rows = tree(spawner.agents)
      const agent = selected ? rows[selected - 1] : undefined
      const leave = () => {
        selected = undefined
        stopArmed = false
      }
      if (matchesKey(data, "down")) selected = Math.min(selected + 1, rows.length)
      else if (matchesKey(data, "up")) selected === 0 ? leave() : selected--
      else if (matchesKey(data, "escape")) leave()
      else if (matchesKey(data, "enter")) {
        if (agent) void open(ctx, spawner, agent)
        leave()
      } else if (data === "x" && agent) {
        if (stopArmed) spawner.stop(agent.id)
        stopArmed = !stopArmed
      } else if (data === "b" && agent) spawner.background(agent)
      else {
        leave()
        fleetTui?.requestRender()
        return undefined // any other key goes to the editor
      }
      if (data !== "x") stopArmed = false
      fleetTui?.requestRender()
      return { consume: true }
    })
  })
  // `@name message` steers a running agent and resumes an ended one. A name that is no agent's,
  // such as an @file reference, leaves the prompt alone.
  pi.on("input", async (e, ctx) => {
    const m = e.source === "extension" ? undefined : mention(e.text)
    const a = m && find(spawner.agents, m.ref)
    if (!m || !a) return { action: "continue" }
    if (a.status === "queued") ctx.ui.notify(`${a.handle} is queued; it reads nothing until it starts.`, "warning")
    else if (live(a)) ctx.ui.notify(spawner.steer(a, m.message), "info")
    else {
      const r = await spawner.start({ resume: a.id, prompt: m.message, description: a.description }, { id: a.parent, depth: a.depth - 1 })
      ctx.ui.notify(typeof r === "string" ? r : `Resumed ${a.handle}; its result arrives as a message.`, typeof r === "string" ? "warning" : "info")
    }
    return { action: "handled" }
  })
  // Agents live in this process; they go with the session.
  pi.on("session_shutdown", () => spawner.shutdown())

  pi.registerCommand("agents", {
    description: "The agent types, their role and the file each comes from",
    handler: async (_args, ctx) => {
      const { errors } = spawner.reload()
      const types = spawner.types()
      await showList(ctx, {
        title: "agent types",
        empty: "No agent types.",
        actions: [{ key: "e", label: "edit", run: async (_row, i) => void (types[i] && (await edit(pi, types[i].path, ctx))) }],
        rows: () => [
          ...types.map((d) => ({
            label: `${d.name.padEnd(16)} ${d.role.padEnd(6)} ${d.description}`,
            detail: () => [d.path, `role ${d.role}, ${d.maxTurns} turns, isolation ${d.isolation}`, `tools ${d.tools?.join(", ") ?? "all"}`, ...(d.allowedAgents.length ? [`may start ${d.allowedAgents.join(", ")}`] : []), "", d.prompt].join("\n"),
          })),
          ...errors.map((e) => ({ label: `skipped: ${e}`, dim: true })),
        ],
      })
    },
  })
}
