import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  isQuotaError, loadActive, loadProfiles, nextProfile, parseActive, parseProfiles, showModel, splitModel, switchTo, writeActive,
} from "../extensions/lib/profiles.ts"

const shipped = readFileSync(new URL("../profiles.json", import.meta.url), "utf8")
const roles = (p: string) => ({ top: `${p}/t`, large: `${p}/l`, small: `${p}/s` })
const file = { order: ["a", "b"], maxConcurrent: 2, profiles: { a: roles("a"), b: roles("b") } }

test("profiles: the shipped file parses, every profile in order", () => {
  const p = parseProfiles(shipped)
  assert.deepEqual(p.order, ["claude", "codex", "copilot", "ollama"])
  assert.deepEqual(showModel(p.profiles.codex.top), "openai-codex/gpt-6.1-sol")
})

test("profiles: invalid files say what is wrong", () => {
  assert.deepEqual(splitModel("ollama/gpt-oss:120b-cloud"), { provider: "ollama", id: "gpt-oss:120b-cloud" })
  assert.throws(() => splitModel("nomodel"), /provider\/model/)
  assert.throws(() => parseProfiles(JSON.stringify({ ...file, maxConcurrent: 0 })), /maxConcurrent/)
  assert.throws(() => parseProfiles(JSON.stringify({ ...file, order: ["a", "c"] })), /"c"/)
  assert.throws(() => parseProfiles(JSON.stringify({ ...file, profiles: { a: roles("a"), b: { top: "b/t" } } })), /b.*"large"/)
  assert.equal(parseProfiles(JSON.stringify(file)).maxConcurrent, 2)
})

test("active: the state file, else the first profile in order", () => {
  const p = parseProfiles(JSON.stringify(file))
  assert.deepEqual(parseActive(undefined, p), { profile: "a", roles: p.profiles.a })
  assert.deepEqual(parseActive("{not json", p), { profile: "a", roles: p.profiles.a })
  const state = JSON.stringify({ profile: "b", roles: { top: "b/t", large: "a/l", small: "b/s" } })
  assert.deepEqual(showModel(parseActive(state, p).roles.large), "a/l")
  // A profile the file no longer has falls back too.
  assert.equal(parseActive(JSON.stringify({ profile: "gone", roles: roles("x") }), p).profile, "a")
})

test("switchTo: an unknown model keeps the previous role's", () => {
  const p = parseProfiles(JSON.stringify(file))
  const from = parseActive(undefined, p)
  const { active, unknown } = switchTo(p, "b", from, (m) => m.id !== "l")
  assert.equal(active.profile, "b")
  assert.deepEqual([active.roles.top, active.roles.large, active.roles.small].map(showModel), ["b/t", "a/l", "b/s"])
  assert.deepEqual(unknown, ["large"])
})

test("nextProfile: the one after in order, none after the last", () => {
  const p = parseProfiles(JSON.stringify(file))
  assert.equal(nextProfile(p, "a"), "b")
  assert.equal(nextProfile(p, "b"), undefined)
})

test("isQuotaError: rate limits and exhausted quotas, not other errors", () => {
  for (const m of ["429 Too Many Requests", "You've hit your usage limit", "insufficient_quota", "rate limit exceeded", "Quota exceeded"])
    assert.ok(isQuotaError(m), m)
  for (const m of ["500 Internal Server Error", "context length exceeded", undefined]) assert.ok(!isQuotaError(m), String(m))
})

test("state file: what writeActive stores, loadActive reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "profiles-"))
  const p = loadProfiles()
  assert.equal(loadActive(dir, p).profile, "claude")
  const { active } = switchTo(p, "codex", loadActive(dir, p), () => true)
  writeActive(dir, active)
  assert.deepEqual(loadActive(dir, p), active)
  assert.equal(JSON.parse(readFileSync(join(dir, "othala-profile.json"), "utf8")).roles.small, "openai-codex/gpt-6-luna")
})
