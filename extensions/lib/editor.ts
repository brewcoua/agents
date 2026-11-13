import { spawn } from "node:child_process"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

// Opens a file in the user's editor; true when it exits cleanly. In the TUI the terminal is handed
// over, as Pi's own ctrl+g does; elsewhere (rpc, print) the editor gets no terminal, which suits a script.
export async function edit(pi: ExtensionAPI, path: string, ctx: ExtensionCommandContext) {
  const [cmd, ...args] = (pi.getSettings().externalEditor || process.env.VISUAL || process.env.EDITOR || "vi").split(" ")
  const run = () =>
    new Promise<number | null>((done) => {
      const child = spawn(cmd, [...args, path], { stdio: ctx.mode === "tui" ? "inherit" : "ignore" })
      child.on("error", () => done(null))
      child.on("close", done)
    })
  let code: number | null = null
  if (ctx.mode === "tui") {
    await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
      tui.stop()
      void run().then((c) => {
        code = c
        tui.start()
        tui.requestRender(true)
        done()
      })
      return { render: () => [], invalidate() {} }
    })
  } else code = await run()
  return code === 0
}
