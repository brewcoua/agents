import assert from "node:assert/strict"
import { test } from "node:test"
import { bearer, buildEntry, parseModelIds, parseShow, showUrl } from "../home/.pi/agent/extensions/models-discovery/discovery.ts"

test("parseModelIds: ids only, junk ignored", () => {
  assert.deepEqual(parseModelIds({ data: [{ id: "a:1b" }, { id: "" }, {}, null, { id: 3 }, { id: "b" }] }), ["a:1b", "b"])
  assert.deepEqual(parseModelIds({ data: "x" }), [])
  assert.deepEqual(parseModelIds(null), [])
})

test("parseShow: context length from model_info, capabilities", () => {
  const s = parseShow({
    capabilities: ["completion", "tools", "vision", "thinking"],
    model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 },
  })
  assert.deepEqual(s, { contextWindow: 40960, vision: true, thinking: true })
  assert.deepEqual(parseShow({}), { contextWindow: undefined, vision: false, thinking: false })
  assert.equal(parseShow({ model_info: { "x.context_length": "big" } }).contextWindow, undefined)
})

test("buildEntry: defaults and show data", () => {
  const d = buildEntry("m")
  assert.equal(d.contextWindow, 128000)
  assert.equal(d.maxTokens, 16384)
  assert.deepEqual(d.input, ["text"])
  assert.equal(d.reasoning, false)
  const e = buildEntry("v", { contextWindow: 8192, vision: true, thinking: true })
  assert.deepEqual([e.contextWindow, e.maxTokens, e.input, e.reasoning], [8192, 8192, ["text", "image"], true])
})

test("bearer: literal and env, never a command", () => {
  const env = { K: "secret" }
  assert.equal(bearer("lit", env), "lit")
  assert.equal(bearer("$K", env), "secret")
  assert.equal(bearer("${K}", env), "secret")
  assert.equal(bearer("$MISSING", env), undefined)
  assert.equal(bearer("!pass show x", env), undefined)
  assert.equal(bearer(undefined, env), undefined)
})

test("showUrl: native endpoint on the same host", () => {
  assert.equal(showUrl("http://localhost:11434/v1"), "http://localhost:11434/api/show")
})
