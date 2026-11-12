import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { checkPath, type Rules } from "../home/.pi/agent/extensions/guardrails/rules.ts"
import { READ_ONLY, onlyReadOnly, parseArgs, transcript } from "../home/.pi/agent/extensions/btw/side.ts"

test("parseArgs: trimmed question, or nothing", () => {
  assert.equal(parseArgs("  what is this?  "), "what is this?")
  assert.equal(parseArgs(" \n "), undefined)
  assert.equal(parseArgs(""), undefined)
})

test("onlyReadOnly drops every tool that can write or run", () => {
  assert.deepEqual(onlyReadOnly(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp__x__y", "codemode"]), READ_ONLY)
  assert.deepEqual(onlyReadOnly(["bash"]), [])
})

test("transcript: user and assistant text only, newest characters kept", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "fix the bug" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", name: "bash" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret output" }] } },
    { type: "custom", message: { role: "user", content: "ignored" } },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "hmm" }] } },
  ]
  assert.equal(transcript(entries, 1000), "User: fix the bug\n\nAssistant: looking")
  assert.equal(transcript(entries, 7), "looking")
  assert.equal(transcript([], 10), "")
})

test("guardrails path rules refuse what the side session's tools would read", () => {
  const rules: Rules = JSON.parse(
    readFileSync(new URL("../home/.pi/agent/extensions/guardrails/rules.json", import.meta.url), "utf8"),
  )
  assert.equal(checkPath(rules, "/work", "/home/u", ".env").verdict, "deny")
  assert.equal(checkPath(rules, "/work", "/home/u", "/work/src/a.ts").verdict, "allow")
  assert.ok(existsSync(new URL("../home/.pi/agent/extensions/guardrails/index.ts", import.meta.url)))
})
