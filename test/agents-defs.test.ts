import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { MAX_TURNS, loadDefs, parseDef } from "../extensions/agents/defs.ts"

const md = (front: string, body = "Do it.") => `---\n${front}\n---\n\n${body}\n`

test("a definition with every field", () => {
  const d = parseDef(md("name: scout\ndescription: Answers one question\nrole: small\ntools: [read, grep]\nmax_turns: 10\nisolation: worktree\nallowed_agents: locate, scout"), "/a/scout.md")
  assert.deepEqual(d, {
    name: "scout", description: "Answers one question", role: "small", tools: ["read", "grep"], maxTurns: 10,
    isolation: "worktree", allowedAgents: ["locate", "scout"], prompt: "Do it.", path: "/a/scout.md",
  })
})

test("defaults: role large, every tool, 50 turns, no isolation, no nested agents", () => {
  const d = parseDef(md("name: x\ndescription: y\ntools: read, bash"), "x.md")
  assert.ok(typeof d !== "string")
  assert.deepEqual([d.role, d.maxTurns, d.isolation, d.allowedAgents, d.tools], ["large", MAX_TURNS, "off", [], ["read", "bash"]])
  const all = parseDef(md("name: x\ndescription: y"), "x.md")
  assert.ok(typeof all !== "string" && all.tools === undefined)
})

test("broken definitions say why", () => {
  assert.equal(parseDef(md("description: y"), "p"), "p: no name")
  assert.equal(parseDef(md("name: x"), "p"), "p: no description")
  assert.equal(parseDef(md("name: x\ndescription: y\nrole: huge"), "p"), "p: role huge is not one of top, large, small")
  assert.equal(parseDef(md("name: x\ndescription: y\nisolation: vm"), "p"), "p: isolation vm is not off or worktree")
  assert.equal(parseDef(md("name: x\ndescription: y\nmax_turns: 0"), "p"), "p: max_turns 0 is not a positive integer")
  assert.match(parseDef("---\nname: [unclosed\n---\n", "p") as string, /^p: /)
})

test("the first directory defining a name wins; broken files are reported; a missing directory is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "defs-"))
  const [a, b] = [join(root, "a"), join(root, "b")]
  mkdirSync(a)
  mkdirSync(b)
  writeFileSync(join(a, "scout.md"), md("name: scout\ndescription: project"))
  writeFileSync(join(b, "scout.md"), md("name: scout\ndescription: package"))
  writeFileSync(join(b, "locate.md"), md("name: locate\ndescription: l"))
  writeFileSync(join(b, "bad.md"), md("name: bad"))
  writeFileSync(join(b, "notes.txt"), "ignored")
  const { defs, errors } = loadDefs([join(root, "none"), a, b])
  assert.deepEqual([...defs.keys()].sort(), ["locate", "scout"])
  assert.equal(defs.get("scout")?.description, "project")
  assert.deepEqual(errors, [`${join(b, "bad.md")}: no description`])
})
