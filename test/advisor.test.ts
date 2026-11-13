import assert from "node:assert/strict"
import { test } from "node:test"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import { NAME, handoff, textOf } from "../extensions/advisor/advisor.ts"

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 })
const assistant = (content: AssistantMessage["content"]) => ({ role: "assistant", content, stopReason: "toolUse", timestamp: 2 }) as unknown as Message
const call = (name: string) => ({ type: "toolCall" as const, id: name, name, arguments: {} })
const text = (t: string) => ({ type: "text" as const, text: t })

test("tool declarations leave the system messages, their text stays", () => {
  const sys = { role: "system", content: "prompt", toolsAdded: [{ name: "read" }], toolsRemoved: [{ name: "x" }], timestamp: 0 } as unknown as Message
  const plain: Message = { role: "system", content: "more", timestamp: 0 } as unknown as Message
  assert.deepEqual(handoff([sys, plain, user("hi")]), [{ role: "system", content: "prompt", timestamp: 0 }, plain, user("hi")])
})

test("the running advisor call goes, other calls stay, and the handoff ends on a user turn", () => {
  const out = handoff([user("hi"), assistant([text("thinking"), call("read"), call(NAME)])])
  assert.deepEqual((out[1] as AssistantMessage).content, [text("thinking"), call("read")])
  assert.equal(out.length, 3)
  assert.equal(out[2].role, "user")
})

test("an assistant turn holding only the advisor call is dropped", () => {
  assert.deepEqual(handoff([user("hi"), assistant([call(NAME)])]), [user("hi")])
  assert.deepEqual(handoff([]), [])
})

test("the advice is the text parts, trimmed", () => {
  const r = { content: [{ type: "thinking", thinking: "x" }, text(" do A "), text("then B\n")] } as unknown as AssistantMessage
  assert.equal(textOf(r), "do A \nthen B")
  assert.equal(textOf({ content: [] } as unknown as AssistantMessage), "")
})
