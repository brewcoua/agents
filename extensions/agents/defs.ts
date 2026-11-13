// Agent types: `<name>.md`, frontmatter then the agent's prompt.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "@earendil-works/pi-coding-agent"
import { ROLES, type Role } from "../lib/profiles.ts"

export type Def = {
  name: string
  description: string
  role: Role
  tools?: string[] // all of the session's tools when absent
  maxTurns: number
  isolation: "off" | "worktree"
  allowedAgents: string[]
  prompt: string
  path: string
}

export const MAX_TURNS = 50

// A YAML list or a comma-separated string.
const list = (v: unknown) =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined

export function parseDef(text: string, path: string): Def | string {
  let parsed: { frontmatter: Record<string, unknown>; body: string }
  try {
    parsed = parseFrontmatter(text)
  } catch (e) {
    return `${path}: ${e instanceof Error ? e.message : e}`
  }
  const f = parsed.frontmatter
  const fail = (why: string) => `${path}: ${why}`
  if (typeof f.name !== "string" || !f.name) return fail("no name")
  if (typeof f.description !== "string" || !f.description) return fail("no description")
  const role = f.role ?? "large"
  if (!ROLES.includes(role as Role)) return fail(`role ${role} is not one of ${ROLES.join(", ")}`)
  const isolation = f.isolation ?? "off"
  if (isolation !== "off" && isolation !== "worktree") return fail(`isolation ${isolation} is not off or worktree`)
  const maxTurns = f.max_turns ?? MAX_TURNS
  if (!Number.isInteger(maxTurns) || (maxTurns as number) < 1) return fail(`max_turns ${maxTurns} is not a positive integer`)
  return {
    name: f.name,
    description: f.description,
    role: role as Role,
    tools: list(f.tools),
    maxTurns: maxTurns as number,
    isolation,
    allowedAgents: list(f.allowed_agents) ?? [],
    prompt: parsed.body.trim(),
    path,
  }
}

// The first directory that defines a name wins; a broken file is reported and skipped.
export function loadDefs(dirs: string[]): { defs: Map<string, Def>; errors: string[] } {
  const defs = new Map<string, Def>()
  const errors: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort()
    } catch {
      continue
    }
    for (const n of names) {
      const d = parseDef(readFileSync(join(dir, n), "utf8"), join(dir, n))
      if (typeof d === "string") errors.push(d)
      else if (!defs.has(d.name)) defs.set(d.name, d)
    }
  }
  return { defs, errors }
}

export const PACKAGE_AGENTS = new URL("../../agents", import.meta.url).pathname
export const defDirs = (cwd: string, agentDir: string) => [join(cwd, ".pi/agents"), join(agentDir, "agents"), PACKAGE_AGENTS]
