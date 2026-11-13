// ask_user_question as rpiv-ask-user-question 2.15 declares it: the same schema, error codes and
// result text, so a model trained on that tool calls this one unchanged.

import { type Static, Type } from "typebox"

export const MAX_QUESTIONS = 4
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4
const MAX_HEADER_LENGTH = 16
const MAX_LABEL_LENGTH = 60
export const TYPED = "Type something."
const RESERVED_LABELS = ["Other", TYPED, "Next"]

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
  }),
  description: Type.String({
    description: "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
  }),
  preview: Type.Optional(
    Type.String({
      description: "Optional preview content shown below the options when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options.",
    }),
  ),
})

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The '${TYPED}' row is appended automatically — do NOT author it.`,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    }),
  ),
})

export const ParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS, description: "Questions to ask the user (1-4 questions)" }),
})

export type Question = Static<typeof QuestionSchema>
export type Params = Static<typeof ParamsSchema>

export type Answer = {
  questionIndex: number
  question: string
  kind: "option" | "custom" | "multi"
  answer: string | null
  selected?: string[]
  preview?: string
}

export type Result = { answers: Answer[]; cancelled: boolean; unanswered?: number[]; error?: string }

export const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)"
export const ERROR_NO_CUSTOM_UI =
  "Error: this client cannot render the questionnaire. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool."
export const DECLINE_MESSAGE = "User declined to answer questions"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const parse = (text: string) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
// A JSON string holding the expected shape is decoded; anything else stays for validation to report.
const decode = (v: unknown, ok: (x: unknown) => boolean) => {
  const p = typeof v === "string" ? parse(v) : v
  return ok(p) ? p : v
}

// Some tool-call parsers (vLLM, LiteLLM serving GLM or Qwen) send `questions`, a question or its
// `options` as a JSON string.
export function prepareArguments(args: unknown): Params {
  if (!isRecord(args)) return args as Params
  const questions = decode(args.questions, Array.isArray)
  if (!Array.isArray(questions)) return args as Params
  return {
    ...args,
    questions: questions.map((q) => {
      const question = decode(q, isRecord)
      if (!isRecord(question)) return question
      const options = decode(question.options, Array.isArray)
      return Array.isArray(options) ? { ...question, options: options.map((o) => decode(o, isRecord)) } : question
    }),
  } as Params
}

// Some models put a bare \r inside strings at token boundaries; in a terminal it overwrites the row.
const clean = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "")

export function normalize(p: Params): Params {
  return {
    ...p,
    questions: p.questions.map((q) => ({
      ...q,
      question: clean(q.question),
      header: clean(q.header),
      options: q.options.map((o) => ({ ...o, label: clean(o.label), description: clean(o.description), ...(o.preview === undefined ? {} : { preview: clean(o.preview) }) })),
    })),
  }
}

export function validate(p: Params): { error: string; message: string } | undefined {
  const fail = (error: string, message: string) => ({ error, message })
  if (p.questions.length === 0) return fail("no_questions", "Error: At least one question is required")
  if (p.questions.length > MAX_QUESTIONS) return fail("too_many_questions", `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`)
  if (new Set(p.questions.map((q) => q.question)).size !== p.questions.length)
    return fail("duplicate_question", "Error: Question text must be unique within an invocation")
  for (const q of p.questions) {
    if (q.options.length < MIN_OPTIONS) return fail("empty_options", `Error: Each question requires at least ${MIN_OPTIONS} options`)
    const labels = q.options.map((o) => o.label)
    if (labels.some((l) => RESERVED_LABELS.includes(l))) return fail("reserved_label", `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})`)
    if (new Set(labels).size !== labels.length) return fail("duplicate_option_label", "Error: Option labels must be unique within a question")
  }
  return undefined
}

export const toolResult = (text: string, details: Result) => ({ content: [{ type: "text" as const, text }], details })

export const scalar = (a: Answer) => {
  const values = a.kind === "multi" ? [...(a.selected ?? []), ...(a.answer ? [a.answer] : [])] : a.answer ? [a.answer] : []
  return values.length ? values.join(", ") : "(no input)"
}

export function respond(r: Result, p: Params) {
  const segments: string[] = []
  const unanswered: number[] = []
  p.questions.forEach((q, i) => {
    const a = r.answers.find((x) => x.questionIndex === i)
    if (!a) return unanswered.push(i)
    segments.push(`"${q.question}"="${scalar(a)}"${a.preview ? `. selected preview: ${a.preview}` : ""}.`)
  })
  if (r.cancelled || !segments.length) return toolResult(DECLINE_MESSAGE, { answers: r.answers, cancelled: true })
  if (unanswered.length) segments.push(`unanswered: ${unanswered.map((i) => `"${p.questions[i].question}"`).join(", ")}.`)
  const details = unanswered.length ? { ...r, unanswered } : r
  return toolResult(`User has answered your questions: ${segments.join(" ")} You can now continue with the user's answers in mind.`, details)
}

// The dialog. A tab per question, then a Submit tab when there are several. Each question lists its
// options and a typed answer row last.
export type State = {
  tab: number
  at: number[] // the focused row of each question
  picked: number[][] // multi-select: the toggled options of each question
  text: string[] // the typed answer of each question
  answers: Answer[]
}

export type Key = "up" | "down" | "left" | "right" | "space" | "enter" | "escape" | "backspace" | { text: string }

export const start = (p: Params): State => ({
  tab: 0,
  at: p.questions.map(() => 0),
  picked: p.questions.map(() => []),
  text: p.questions.map(() => ""),
  answers: [],
})

export const tabs = (p: Params) => p.questions.length + (p.questions.length > 1 ? 1 : 0)
export const typing = (s: State, p: Params) => s.tab < p.questions.length && s.at[s.tab] === p.questions[s.tab].options.length

const set = <T>(xs: T[], i: number, v: T) => xs.map((x, j) => (j === i ? v : x))

// The next state, or the dialog's result once it is submitted or cancelled.
export function step(s: State, p: Params, key: Key): State | Result {
  if (key === "escape") return { answers: s.answers, cancelled: true }
  const done = (answers: Answer[]): Result => ({ answers: [...answers].sort((a, b) => a.questionIndex - b.questionIndex), cancelled: false })
  if (key === "left" || key === "right") return { ...s, tab: (s.tab + (key === "left" ? -1 : 1) + tabs(p)) % tabs(p) }
  if (s.tab === p.questions.length) return key === "enter" ? done(s.answers) : s

  const i = s.tab
  const q = p.questions[i]
  const at = s.at[i]
  const text = s.text[i]
  if (key === "up" || key === "down") return { ...s, at: set(s.at, i, Math.max(0, Math.min(q.options.length, at + (key === "up" ? -1 : 1)))) }
  if (typing(s, p)) {
    if (key === "backspace") return { ...s, text: set(s.text, i, [...text].slice(0, -1).join("")) }
    if (key === "space" || typeof key === "object") return { ...s, text: set(s.text, i, text + (key === "space" ? " " : key.text)) }
  } else if (key === "space" && q.multiSelect) {
    const picked = s.picked[i].includes(at) ? s.picked[i].filter((x) => x !== at) : [...s.picked[i], at]
    return { ...s, picked: set(s.picked, i, picked) }
  }
  if (key !== "enter") return s

  const base = { questionIndex: i, question: q.question }
  let answer: Answer
  if (q.multiSelect) {
    if (typing(s, p) && !text.trim()) return s
    const picked = s.picked[i].length || typing(s, p) ? s.picked[i] : [at]
    const selected = q.options.filter((_, j) => picked.includes(j)).map((o) => o.label)
    answer = { ...base, kind: "multi", answer: typing(s, p) ? text : null, selected }
  } else if (typing(s, p)) {
    if (!text.trim()) return s
    answer = { ...base, kind: "custom", answer: text }
  } else {
    const o = q.options[at]
    answer = { ...base, kind: "option", answer: o.label, ...(o.preview ? { preview: o.preview } : {}) }
  }
  const answers = [...s.answers.filter((a) => a.questionIndex !== i), answer]
  return p.questions.length === 1 ? done(answers) : { ...s, answers, tab: i + 1 }
}

export const isResult = (x: State | Result): x is Result => "cancelled" in x
