// Pure logic of the guardrails extension: no Pi imports, so node --test runs it.

export type Verdict = "allow" | "ask" | "deny"
export type Decision = { verdict: Verdict; reason: string }

export type Rules = {
  tools: Record<string, Verdict>
  bash: Record<string, Verdict>
  bashRegex: { pattern: string; flags?: string; verdict: Verdict; reason: string }[]
  interpreters: string[]
  opaque: string[]
  paths: Record<string, Verdict>
  external: Record<string, Verdict>
  maxOutputChars: number
}

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 }

export function strictest(a: Decision, b: Decision): Decision {
  return RANK[b.verdict] > RANK[a.verdict] ? b : a
}

// `*` matches anything, slashes included, as in opencode's permission globs.
// A trailing " *" also matches the bare command: `ls *` matches `ls`.
export function glob(pattern: string, text: string): boolean {
  if (pattern.endsWith(" *") && text === pattern.slice(0, -2)) return true
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${re}$`, "s").test(text)
}

// The last matching rule wins, so a table reads from general to specific.
export function lastMatch(table: Record<string, Verdict>, text: string): Verdict | undefined {
  let found: Verdict | undefined
  for (const [pattern, verdict] of Object.entries(table)) if (glob(pattern, text)) found = verdict
  return found
}

export type Command = {
  words: string[]
  piped: boolean // fed by the previous command through a pipe
  redirects: { op: string; target: string }[]
}
export type Parsed = {
  commands: Command[]
  ask: string[] // constructs that cannot be checked: the user decides
  error?: string // unparseable: refused
}

const OPERATORS = ["&&", "||", "|&", ";", "|", "&", "\n"]
const REDIRECTS = ["<<<", "<<-", "<<", ">>", ">&", "&>", "<&", ">|", ">", "<"]

// Words, quotes, `&& || ; | &` and redirections. Anything that runs code the
// tokenizer cannot see ($(...), backticks, subshells, heredocs, process
// substitution) is reported in `ask` and parsing stops there: the user is shown
// the whole command, and what was parsed so far is still checked for deny.
export function parse(src: string): Parsed {
  const out: Parsed = { commands: [], ask: [] }
  let cmd: Command = { words: [], piped: false, redirects: [] }
  let word = ""
  let inWord = false
  let pendingRedirect: string | undefined

  const endWord = () => {
    if (!inWord) return
    if (pendingRedirect) {
      cmd.redirects.push({ op: pendingRedirect, target: word })
      pendingRedirect = undefined
    } else cmd.words.push(word)
    word = ""
    inWord = false
  }
  const endCommand = (piped: boolean) => {
    endWord()
    if (cmd.words.length || cmd.redirects.length) out.commands.push(cmd)
    cmd = { words: [], piped, redirects: [] }
  }
  const stop = (why: string) => {
    out.ask.push(why)
    endCommand(false)
    return out
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") {
      if (i + 1 >= src.length) return { ...out, error: "trailing backslash" }
      if (src[i + 1] !== "\n") (word += src[i + 1]), (inWord = true)
      i += 2
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return { ...out, error: "unterminated single quote" }
      word += src.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (c === '"') {
      inWord = true
      i++
      for (;;) {
        if (i >= src.length) return { ...out, error: "unterminated double quote" }
        const d = src[i]
        if (d === '"') break
        if (d === "`" || (d === "$" && src[i + 1] === "(")) return stop("command substitution")
        if (d === "\\" && i + 1 < src.length) {
          if ('$`"\\'.includes(src[i + 1])) word += src[i + 1]
          else if (src[i + 1] !== "\n") word += d + src[i + 1]
          i += 2
        } else (word += d), i++
      }
      i++
    } else if (c === "`") return stop("command substitution")
    else if (c === "$" && src[i + 1] === "(") return stop("command substitution")
    else if (c === "(" || c === ")" || (c === "{" && !inWord && /\s/.test(src[i + 1] ?? " ")))
      return stop("subshell or group")
    else if ((c === "<" || c === ">") && src[i + 1] === "(") return stop("process substitution")
    else if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i++
    } else if (c === " " || c === "\t") {
      endWord()
      i++
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i))
      const redirect = REDIRECTS.find((o) => src.startsWith(o, i))
      if (redirect) {
        if (redirect === "<<" || redirect === "<<-") return stop("heredoc")
        // `2>file`: the fd digits belong to the operator, not to a word
        if (inWord && /^\d+$/.test(word)) (word = ""), (inWord = false)
        else endWord()
        pendingRedirect = redirect
        i += redirect.length
        // `>&2`, `2>&1`: the target is a descriptor, never a path
        const fd = /^-|^\d+/.exec(src.slice(i))
        if ((redirect === ">&" || redirect === "<&") && fd) {
          cmd.redirects.push({ op: redirect, target: fd[0] })
          pendingRedirect = undefined
          i += fd[0].length
        }
      } else if (op) {
        if (pendingRedirect) return { ...out, error: `redirection ${pendingRedirect} has no target` }
        endCommand(op === "|" || op === "|&")
        i += op.length
      } else {
        word += c
        inWord = true
        i++
      }
    }
  }
  if (pendingRedirect && !inWord) return { ...out, error: `redirection ${pendingRedirect} has no target` }
  endCommand(false)
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function base(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1)
}

// Words of the command proper: leading `VAR=value` assignments are not part of it.
function program(words: string[]): string[] {
  let n = 0
  while (n < words.length && ASSIGNMENT.test(words[n])) n++
  return words.slice(n)
}

export function isSecret(rules: Rules, path: string): boolean {
  return lastMatch(rules.paths, path) === "deny"
}

const SAFE_SINKS = /^(\/dev\/(null|stdout|stderr)|\/tmp\/.*|\/var\/tmp\/.*)$/

export function checkCommand(rules: Rules, command: string, cwd = "/"): Decision {
  const parsed = parse(command)
  if (parsed.error) return { verdict: "deny", reason: `cannot parse this shell command (${parsed.error})` }
  let result: Decision = { verdict: "allow", reason: "" }
  for (const why of parsed.ask) result = strictest(result, { verdict: "ask", reason: `contains ${why}` })

  for (const cmd of parsed.commands) {
    const words = program(cmd.words)
    const text = words.join(" ")
    let own: Decision = { verdict: lastMatch(rules.bash, text) ?? "ask", reason: `\`${text}\` matches no allow rule` }
    if (own.verdict === "allow") own = { verdict: "allow", reason: "" }
    else if (own.verdict === "deny") own.reason = `\`${text}\` is denied by a rule`

    for (const r of rules.bashRegex) {
      if (new RegExp(r.pattern, r.flags).test(text)) own = strictest(own, { verdict: r.verdict, reason: r.reason })
    }
    const name = base(words[0] ?? "")
    if (cmd.piped && rules.interpreters.includes(name)) {
      own = strictest(own, { verdict: "deny", reason: `piping into ${name}` })
    }
    if (rules.opaque.includes(name)) own = strictest(own, { verdict: "ask", reason: `${name} runs code that cannot be checked` })
    if (rules.interpreters.includes(name) && words.includes("-c")) {
      own = strictest(own, { verdict: "ask", reason: `${name} -c runs code that cannot be checked` })
    }
    for (const w of words.slice(1)) {
      if (isSecret(rules, resolve(cwd, w))) own = strictest(own, { verdict: "deny", reason: `${w} holds secrets` })
    }
    for (const r of cmd.redirects) {
      if (r.op === ">&" || r.op === "<&") continue
      const target = resolve(cwd, r.target)
      if (isSecret(rules, target)) own = strictest(own, { verdict: "deny", reason: `${r.target} holds secrets` })
      else if (r.op !== "<" && r.op !== "<<<" && !SAFE_SINKS.test(target)) {
        own = strictest(own, { verdict: "ask", reason: `writes to ${r.target}` })
      }
    }
    result = strictest(result, own)
  }
  if (parsed.commands.length === 0 && result.verdict === "allow") {
    result = { verdict: "ask", reason: "empty command" }
  }
  return result
}

export function resolve(cwd: string, path: string): string {
  const parts: string[] = []
  const full = path.startsWith("/") ? path : `${cwd}/${path}`
  for (const p of full.split("/")) {
    if (p === "..") parts.pop()
    else if (p && p !== ".") parts.push(p)
  }
  return `/${parts.join("/")}`
}

export function toolVerdict(rules: Rules, tool: string): Verdict {
  return rules.tools[tool] ?? rules.tools["*"] ?? "allow"
}

// Inside the project directory a path is allowed. Outside, a read follows `external`, and an edit
// always asks: /tmp is no scratch space for edits.
export function checkPath(rules: Rules, cwd: string, home: string, path: string, edits = false): Decision {
  const abs = resolve(cwd, path.startsWith("~/") ? home + path.slice(1) : path)
  if (isSecret(rules, abs)) return { verdict: "deny", reason: `${path} holds secrets` }
  if (abs === cwd || abs.startsWith(`${cwd}/`)) return { verdict: "allow", reason: "" }
  if (edits) return { verdict: "ask", reason: `${path} is outside the project directory` }
  const external = Object.fromEntries(
    Object.entries(rules.external).map(([k, v]) => [k.startsWith("~/") ? home + k.slice(1) : k, v]),
  )
  const verdict = lastMatch(external, abs) ?? "ask"
  return { verdict, reason: `${path} is outside the project directory` }
}

// Commit rule (agents-common AGENTS.md, section 11).
const FORBIDDEN: [RegExp, string][] = [
  [/Co-Authored-By/i, "Co-Authored-By"],
  [/Generated with/i, '"Generated with"'],
  [/\bclaude\b/i, "Claude"],
  [/\bPi\b/, "Pi"],
  [/\bAI\b/, "AI"],
]

export function forbiddenIn(message: string): string | undefined {
  return FORBIDDEN.find(([re]) => re.test(message))?.[1]
}

// git options that take a separate value, before the subcommand.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])

export function commitMessages(words: string[], readFile: (path: string) => string | undefined): string[] {
  const w = program(words)
  if (base(w[0] ?? "") !== "git") return []
  let i = 1
  while (i < w.length && w[i].startsWith("-")) i += GIT_VALUE_OPTS.has(w[i]) ? 2 : 1
  if (w[i] !== "commit") return []
  const messages: string[] = []
  for (let j = i + 1; j < w.length; j++) {
    const a = w[j]
    let m: RegExpExecArray | null
    if (a === "--") break
    else if ((m = /^--(?:message|file)=(.*)$/s.exec(a))) messages.push(a.startsWith("--file") ? (readFile(m[1]) ?? "") : m[1])
    else if (a === "--message") messages.push(w[++j] ?? "")
    else if (a === "--file") messages.push(readFile(w[++j] ?? "") ?? "")
    else if ((m = /^-[a-zA-Z]*m(.*)$/s.exec(a)) && !a.startsWith("--")) messages.push(m[1] || (w[++j] ?? ""))
    else if ((m = /^-[a-zA-Z]*F(.*)$/s.exec(a)) && !a.startsWith("--")) messages.push(readFile(m[1] || (w[++j] ?? "")) ?? "")
  }
  return messages
}

// A message that cannot be extracted (an editor commit, `-F -`) is allowed.
// When the command holds a substitution or heredoc the message sits inside it,
// so the raw text is scanned instead.
export function checkCommit(command: string, readFile: (path: string) => string | undefined): Decision | undefined {
  const parsed = parse(command)
  if (parsed.error) return undefined
  const messages = parsed.commands.flatMap((c) => commitMessages(c.words, readFile))
  if (parsed.ask.length && /\bgit\b[^\n]*\bcommit\b/.test(command)) messages.push(command)
  for (const message of messages) {
    const hit = forbiddenIn(message)
    if (hit) return { verdict: "deny", reason: `commit message contains ${hit}; commit messages never mention Claude, Pi or AI and carry no Co-Authored-By or "Generated with" line` }
  }
  return undefined
}

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"])

// What a task's child may run besides its verify command: `git add <paths>` where every path is
// one of the task's files, and `git commit`. Nothing piped, redirected or substituted.
export function taskGit(command: string, files: string[], cwd: string): boolean {
  const parsed = parse(command)
  if (parsed.error || parsed.ask.length || !parsed.commands.length) return false
  return parsed.commands.every((c) => {
    const [git, sub, ...args] = c.words
    if (git !== "git" || c.piped || c.redirects.length) return false
    if (sub === "commit") return true
    if (sub !== "add") return false
    const paths = args[0] === "--" ? args.slice(1) : args
    return (
      paths.length > 0 &&
      paths.every((p) => {
        const abs = resolve(cwd, p)
        return !p.startsWith("-") && abs.startsWith(`${cwd}/`) && files.some((g) => glob(g, abs.slice(cwd.length + 1)))
      })
    )
  })
}

export type Env = {
  home: string
  readFile: (path: string) => string | undefined
  taskFiles?: string[] // OTHALA_TASK_FILES: set in a task's child pi
  taskVerify?: string // OTHALA_TASK_VERIFY
  realpath?: (path: string) => string // for edits; absent in tests, where paths are lexical
}

// The verdict for one tool call. In a task's child nobody can answer, so ask becomes deny.
export function decide(rules: Rules, env: Env, toolName: string, input: Record<string, unknown>, cwd: string): Decision {
  let d: Decision = { verdict: toolVerdict(rules, toolName), reason: `the ${toolName} tool needs confirmation` }
  if (d.verdict === "deny") return { verdict: "deny", reason: `the ${toolName} tool is denied` }

  if (toolName === "bash") {
    const command = String(input.command ?? "")
    if (command === env.taskVerify) return { verdict: "allow", reason: "" }
    d = strictest(d, checkCommand(rules, command, cwd))
    if (d.verdict === "ask" && env.taskFiles && taskGit(command, env.taskFiles, cwd)) d = { verdict: "allow", reason: "" }
    d = strictest(d, checkCommit(command, (p) => env.readFile(resolve(cwd, p))) ?? d)
  } else if (PATH_TOOLS.has(toolName)) {
    const path = String(input.path ?? input.file_path ?? ".")
    const edits = toolName === "edit" || toolName === "write"
    // An edit follows symlinks: a link in the project to /etc is no way out of it.
    const real = edits && env.realpath ? env.realpath : (p: string) => p
    const root = real(cwd)
    const abs = real(resolve(cwd, path.startsWith("~/") ? env.home + path.slice(1) : path))
    const inside = abs.startsWith(`${root}/`)
    const inTask = inside && env.taskFiles?.some((g) => glob(g, abs.slice(root.length + 1)))
    d = strictest(d, checkPath(rules, root, env.home, abs, edits))
    // hooks and config there run code on the next git command
    if (edits && abs.startsWith(`${root}/.git/`)) d = strictest(d, { verdict: "ask", reason: `${path} is inside .git` })
    if (env.taskFiles && edits && !inTask && d.verdict !== "deny") {
      d = {
        verdict: "deny",
        reason: inside
          ? `${path} is outside the files of this task; if the task cannot be done without it, call request_files`
          : `${path} is outside the project`,
      }
    }
  }
  if (env.taskFiles && d.verdict === "ask") d = { verdict: "deny", reason: `${d.reason}, and a task cannot ask` }
  return d
}

// Keeps both ends: a command's verdict is usually in its last lines.
export function cap(text: string, max: number): string | undefined {
  if (text.length <= max) return undefined
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n[guardrails: output cut, ${text.length - max} of ${text.length} characters removed]\n${text.slice(-half)}`
}
