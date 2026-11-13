import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { decodeKittyPrintable, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { rule } from "../lib/view.ts"
import {
  ERROR_NO_CUSTOM_UI, ERROR_NO_UI, type Key, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, type Params, ParamsSchema, type Result, type State, TYPED,
  isResult, normalize, prepareArguments, respond, scalar, start, step, tabs, toolResult, typing, validate,
} from "./ask.ts"

const NAME = "ask_user_question"

const DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "${TYPED}" row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "${TYPED}" labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.
- Use the optional \`preview\` field on options for concrete artifacts the user needs to compare: ASCII mockups, code snippets, diagrams, configuration examples. It is shown below the options while that option is focused.`

const GUIDELINES = [
  `Use ${NAME} whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
  `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "${TYPED}" row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "${TYPED}" labels yourself — reserved labels are rejected at runtime.`,
  `Do not stack multiple ${NAME} calls back-to-back — group all clarifying questions into one invocation.`,
]

function toKey(data: string): Key | undefined {
  const named = (["up", "down", "left", "right", "space", "enter", "escape", "backspace"] as const).find((k) => matchesKey(data, k))
  if (named) return named
  if (matchesKey(data, "tab")) return "right"
  if (matchesKey(data, "shift+tab")) return "left"
  if (matchesKey(data, "ctrl+c")) return "escape"
  const text = decodeKittyPrintable(data) ?? (/[\x00-\x1f\x7f]/.test(data) ? undefined : data) // a paste arrives whole
  return text ? { text } : undefined
}

function dialog(ctx: ExtensionContext, p: Params): Promise<Result> {
  return ctx.ui.custom<Result>((tui, theme, _kb, done) => {
    let s: State = start(p)
    const n = p.questions.length
    const wrap = (text: string, width: number, indent: string) => wrapTextWithAnsi(text, Math.max(10, width - indent.length)).map((l) => indent + l)

    function render(width: number): string[] {
      const out = [rule(theme, width, "question")]
      if (n > 1) {
        const chip = (label: string, i: number) => {
          const mark = i < n && s.answers.some((a) => a.questionIndex === i) ? "* " : ""
          return i === s.tab ? theme.fg("accent", `[${mark}${label}]`) : theme.fg("dim", ` ${mark}${label} `)
        }
        out.push(truncateToWidth(` ${[...p.questions.map((q) => q.header), "Submit"].map(chip).join(" ")}`, width))
      }
      if (s.tab === n) {
        for (const [i, q] of p.questions.entries()) {
          const a = s.answers.find((x) => x.questionIndex === i)
          out.push(...wrap(`${q.question} ${a ? scalar(a) : theme.fg("warning", "(unanswered)")}`, width, " "))
        }
        out.push(theme.fg("dim", truncateToWidth(" enter submit  ←/→ tabs  esc cancel", width)))
        return out
      }
      const q = p.questions[s.tab]
      out.push(...wrap(theme.bold(q.question), width, " "))
      const at = s.at[s.tab]
      q.options.forEach((o, i) => {
        const box = q.multiSelect ? (s.picked[s.tab].includes(i) ? "[x] " : "[ ] ") : ""
        const line = `${i === at ? ">" : " "} ${i + 1}. ${box}${o.label}`
        out.push(truncateToWidth(i === at ? theme.fg("accent", line) : line, width))
        out.push(...wrap(theme.fg("dim", o.description), width, "      "))
      })
      const typed = typing(s, p) ? theme.fg("accent", `> ${q.options.length + 1}. ${s.text[s.tab]}█`) : `  ${q.options.length + 1}. ${s.text[s.tab] || theme.fg("dim", TYPED)}`
      out.push(truncateToWidth(typed, width))
      const preview = q.options[at]?.preview
      if (preview) out.push("", ...preview.split("\n").map((l) => truncateToWidth(`  ${theme.fg("dim", "│")} ${l}`, width)))
      const keys = [...(q.multiSelect ? ["space toggle", "enter confirm"] : ["enter select"]), "↑/↓ move", ...(n > 1 ? ["←/→ tabs"] : []), "esc cancel"]
      out.push(theme.fg("dim", truncateToWidth(` ${keys.join("  ")}`, width)))
      return out
    }

    return {
      render,
      handleInput(data: string) {
        const key = toKey(data)
        if (!key) return
        const next = step(s, p, key)
        if (isResult(next)) return done(next)
        s = next
        tui.requestRender()
      },
      invalidate() {},
    }
  })
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: NAME,
    label: "Ask User Question",
    exposure: "model-only",
    description: DESCRIPTION,
    promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`,
    promptGuidelines: GUIDELINES,
    parameters: ParamsSchema,
    prepareArguments,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = normalize(params)
      if (!ctx.hasUI) return toolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" })
      const invalid = validate(p)
      if (invalid) return toolResult(invalid.message, { answers: [], cancelled: true, error: invalid.error })
      // RPC hosts have dialogs but no custom components; the model asks in chat instead.
      if (ctx.mode !== "tui") return toolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" })
      return respond(await dialog(ctx, p), p)
    },
  })

  // Only the interactive UI can show the dialog, so elsewhere the model is not offered the tool.
  const reconcile = (_e: unknown, ctx: ExtensionContext) => {
    const active = pi.getActiveTools()
    const has = active.includes(NAME)
    if (ctx.mode !== "tui" && has) pi.setActiveTools(active.filter((t) => t !== NAME))
    else if (ctx.mode === "tui" && !has) pi.setActiveTools([...active, NAME])
  }
  pi.on("session_start", reconcile)
  pi.on("before_agent_start", reconcile)
}
