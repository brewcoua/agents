// Provider profiles: which model each role uses. No Pi imports, so node --test runs it.

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type Model = { provider: string; id: string }
export const ROLES = ["top", "large", "small"] as const
export type Role = (typeof ROLES)[number]
export type Roles = Record<Role, Model>
export type Profiles = { order: string[]; maxConcurrent: number; profiles: Record<string, Roles> }
// The profile switched to last, and the model each role resolved to then.
export type Active = { profile: string; roles: Roles }

// "claude-bridge/claude-opus-5-5": the provider is everything before the first slash.
export function splitModel(text: string): Model {
  const i = text.indexOf("/")
  if (i < 1 || i === text.length - 1) throw new Error(`"${text}" is not a provider/model pair`)
  return { provider: text.slice(0, i), id: text.slice(i + 1) }
}

export const showModel = (m: Model) => `${m.provider}/${m.id}`

function parseRoles(raw: unknown, where: string): Roles {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: Partial<Roles> = {}
  for (const role of ROLES) {
    if (typeof r[role] !== "string") throw new Error(`${where}: "${role}" must be a "provider/model" string`)
    out[role] = splitModel(r[role])
  }
  return out as Roles
}

export function parseProfiles(text: string): Profiles {
  const raw = JSON.parse(text) as Record<string, unknown>
  const profiles: Record<string, Roles> = {}
  for (const [name, roles] of Object.entries((raw.profiles ?? {}) as Record<string, unknown>))
    profiles[name] = parseRoles(roles, `profiles.json: profile ${name}`)
  const order = raw.order
  if (!Array.isArray(order) || order.length === 0) throw new Error('profiles.json: "order" must list the profiles')
  for (const name of order) if (!profiles[name]) throw new Error(`profiles.json: "order" names "${name}", which is not a profile`)
  const n = raw.maxConcurrent
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error('profiles.json: "maxConcurrent" must be a positive integer')
  return { order, maxConcurrent: n, profiles }
}

// The state file as written by writeActive; anything unreadable means the first profile in order.
export function parseActive(text: string | undefined, p: Profiles): Active {
  try {
    const raw = JSON.parse(text ?? "") as { profile?: unknown; roles?: unknown }
    if (typeof raw.profile === "string" && p.profiles[raw.profile]) return { profile: raw.profile, roles: parseRoles(raw.roles, "state") }
  } catch {
    // fall through to the default
  }
  return { profile: p.order[0], roles: p.profiles[p.order[0]] }
}

// Each role takes the profile's model, unless `known` does not know it: then it keeps the one it had.
export function switchTo(p: Profiles, name: string, from: Active, known: (m: Model) => boolean): { active: Active; unknown: Role[] } {
  const roles = { ...from.roles }
  const unknown: Role[] = []
  for (const role of ROLES) {
    const m = p.profiles[name][role]
    if (known(m)) roles[role] = m
    else unknown.push(role)
  }
  return { active: { profile: name, roles }, unknown }
}

export function nextProfile(p: Profiles, current: string): string | undefined {
  const i = p.order.indexOf(current)
  return i >= 0 ? p.order[i + 1] : undefined
}

// What providers say when a subscription or rate limit runs out. Unverified per provider: widen as real errors come in.
export const isQuotaError = (message: string | undefined) =>
  !!message && /\b429\b|rate.?limit|usage limit|quota|too many requests/i.test(message)

const PROFILES = new URL("../../profiles.json", import.meta.url)
const STATE = "othala-profile.json"

export const loadProfiles = () => parseProfiles(readFileSync(PROFILES, "utf8"))

export function loadActive(agentDir: string, p = loadProfiles()): Active {
  let text: string | undefined
  try {
    text = readFileSync(join(agentDir, STATE), "utf8")
  } catch {
    // no switch yet
  }
  return parseActive(text, p)
}

export function writeActive(agentDir: string, a: Active) {
  const roles = Object.fromEntries(ROLES.map((r) => [r, showModel(a.roles[r])]))
  writeFileSync(join(agentDir, STATE), `${JSON.stringify({ profile: a.profile, roles }, null, 2)}\n`)
}
