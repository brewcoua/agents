import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DECLINE_MESSAGE, type Key, type Params, type Result, type State, isResult, normalize, prepareArguments, respond, start, step, tabs, typing, validate,
} from "../extensions/ask/ask.ts"

const opt = (label: string, preview?: string) => ({ label, description: `${label} means`, ...(preview ? { preview } : {}) })
const one: Params = { questions: [{ question: "Which?", header: "Pick", options: [opt("A"), opt("B", "b preview")] }] }
const two: Params = {
  questions: [
    { question: "Which?", header: "Pick", options: [opt("A"), opt("B")] },
    { question: "Features?", header: "Feat", options: [opt("X"), opt("Y"), opt("Z")], multiSelect: true },
  ],
}

function press(p: Params, ...keys: Key[]): State | Result {
  let s: State | Result = start(p)
  for (const k of keys) {
    assert.ok(!isResult(s), `result before ${JSON.stringify(k)}`)
    s = step(s, p, k)
  }
  return s
}
const text = (r: State | Result) => (assert.ok(isResult(r)), respond(r, two).content[0].text)

test("questions sent as JSON strings are decoded, at every level", () => {
  const q = { question: "Which?", header: "Pick", options: [opt("A"), JSON.stringify(opt("B"))] }
  assert.deepEqual(prepareArguments({ questions: JSON.stringify([q]) }), { questions: [{ ...q, options: [opt("A"), opt("B")] }] })
  assert.deepEqual(prepareArguments({ questions: [JSON.stringify({ ...q, options: JSON.stringify(q.options) })] }).questions[0].options, [opt("A"), opt("B")])
  assert.deepEqual(prepareArguments({ questions: "not json" }), { questions: "not json" })
  assert.deepEqual(prepareArguments({ questions: ["[1]"] }), { questions: ["[1]"] })
  assert.equal(prepareArguments("x"), "x")
})

test("a carriage return is dropped, a CRLF becomes a newline", () => {
  const p = normalize({ questions: [{ question: "Wh\rich?", header: "P\r\nk", options: [opt("A\r"), opt("B", "x\r\ny")] }] })
  assert.equal(p.questions[0].question, "Which?")
  assert.equal(p.questions[0].header, "P\nk")
  assert.deepEqual(p.questions[0].options, [opt("A"), opt("B", "x\ny")])
  assert.equal("preview" in p.questions[0].options[0], false)
})

test("validation reports rpiv's error codes and messages", () => {
  const q = one.questions[0]
  const code = (p: Params) => validate(p)?.error
  assert.equal(validate(one), undefined)
  assert.deepEqual(validate({ questions: [] }), { error: "no_questions", message: "Error: At least one question is required" })
  assert.equal(code({ questions: [1, 2, 3, 4, 5].map((n) => ({ ...q, question: `${n}?` })) }), "too_many_questions")
  assert.equal(code({ questions: [q, q] }), "duplicate_question")
  assert.equal(code({ questions: [{ ...q, options: [opt("A")] }] }), "empty_options")
  assert.deepEqual(validate({ questions: [{ ...q, options: [opt("A"), opt("Other")] }] }), {
    error: "reserved_label",
    message: "Error: Option label is reserved (Other, Type something., Next)",
  })
  assert.equal(code({ questions: [{ ...q, options: [opt("A"), opt("A")] }] }), "duplicate_option_label")
})

test("a single question ends on its answer", () => {
  const r = press(one, "down", "enter")
  assert.deepEqual(r, {
    answers: [{ questionIndex: 0, question: "Which?", kind: "option", answer: "B", preview: "b preview" }],
    cancelled: false,
  })
  assert.equal(
    respond(r as Result, one).content[0].text,
    `User has answered your questions: "Which?"="B". selected preview: b preview. You can now continue with the user's answers in mind.`,
  )
})

test("escape cancels, and the model reads a decline", () => {
  const r = press(two, "enter", "escape")
  assert.equal(text(r), DECLINE_MESSAGE)
  assert.equal((r as Result).cancelled, true)
  assert.equal(respond({ answers: [], cancelled: false }, two).content[0].text, DECLINE_MESSAGE)
})

test("several questions: answering moves on, and Submit sends them in order", () => {
  const r = press(two, "enter", "space", "down", "down", "space", "enter", "enter")
  assert.equal(text(r), `User has answered your questions: "Which?"="A". "Features?"="X, Z". You can now continue with the user's answers in mind.`)
  assert.deepEqual((r as Result).answers[1], { questionIndex: 1, question: "Features?", kind: "multi", answer: null, selected: ["X", "Z"] })
})

test("multi-select with nothing toggled takes the focused option; space untoggles", () => {
  assert.equal(text(press(two, "right", "down", "enter", "enter")), `User has answered your questions: "Features?"="Y". unanswered: "Which?". You can now continue with the user's answers in mind.`)
  const s = press(two, "right", "space", "space")
  assert.ok(!isResult(s))
  assert.deepEqual(s.picked[1], [])
})

test("the typed row takes text, backspace and spaces; a blank answer is refused", () => {
  const s = press(one, "down", "down", "enter", { text: "my" }, "space", { text: "wayy" }, "backspace")
  assert.ok(!isResult(s) && typing(s, one))
  assert.equal(s.text[0], "my way")
  assert.deepEqual(step(s, one, "enter"), { answers: [{ questionIndex: 0, question: "Which?", kind: "custom", answer: "my way" }], cancelled: false })
  assert.equal(text(press(two, "right", "space", "down", "down", "down", "enter", { text: "W" }, "enter", "enter")), `User has answered your questions: "Features?"="X, W". unanswered: "Which?". You can now continue with the user's answers in mind.`)
})

test("keys that do nothing leave the state alone; tabs wrap", () => {
  const s = start(two)
  assert.equal(step(s, two, { text: "x" }), s)
  assert.equal(step(s, two, "space"), s)
  assert.equal(step(s, two, "backspace"), s)
  assert.equal((step(s, two, "left") as State).tab, 2)
  assert.equal((step({ ...s, tab: 2 }, two, "up") as State).tab, 2)
  assert.equal((step(s, two, "up") as State).at[0], 0)
  assert.equal(tabs(one), 1)
  assert.equal(tabs(two), 3)
  const typed = press(two, "right", "down", "down", "down", "enter")
  assert.ok(!isResult(typed) && typing(typed, two))
})

test("an answer replaces the earlier one for the same question", () => {
  const r = press(two, "enter", "left", "down", "enter", "right", "enter")
  assert.equal(text(r), `User has answered your questions: "Which?"="B". unanswered: "Features?". You can now continue with the user's answers in mind.`)
  assert.deepEqual((respond(r as Result, two).details as Result).unanswered, [1])
})
