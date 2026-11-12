import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { MAX_DIFF_CHARS, capDiff, parseArgs } from "./diff.ts"

export default function (pi: ExtensionAPI) {
  pi.registerCommand("simplify", {
    description: "Review `git diff` (default: HEAD, staged and unstaged) for cuts: /simplify [ref]",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args)
      if ("error" in parsed) return ctx.ui.notify(parsed.error, "error")

      const git = await pi.exec("git", ["diff", "--no-ext-diff", parsed.ref ?? "HEAD", "--"], { cwd: ctx.cwd })
      if (git.code !== 0) return ctx.ui.notify(git.stderr.trim() || "git diff failed", "error")
      if (!git.stdout.trim()) return ctx.ui.notify("No diff to simplify.", "info")

      const { text, omitted } = capDiff(git.stdout, MAX_DIFF_CHARS)
      const left = omitted.length
        ? `\n\nThe diff was too large. Left out, read them with git diff if needed:\n${omitted.map((f) => `- ${f}`).join("\n")}`
        : ""
      pi.sendUserMessage(`Use the simplify skill on this diff.\n\n\`\`\`diff\n${text}\`\`\`${left}`)
    },
  })
}
