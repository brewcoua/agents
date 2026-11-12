# Pi

The `pi` module installs [Pi](https://pi.dev), a terminal coding agent, and configures it to make no
request nobody asked for. It requires `agents-common` and `claude`: Claude reaches Pi through a
bridge that runs the real `claude` binary.

```
modules/tools/pi/
├── module.json                       # packages, the npm recipe, the pi emitter
├── home/
│   ├── .local/bin/pi                 # the wrapper: sets the environment, runs the install
│   └── .pi/agent/
│       ├── models.json               # ollama
│       ├── extensions/guardrails/    # allow, ask and deny rules; rules.json holds them
│       └── AGENTS.md -> ../../../../agents-common/home/.config/agents/AGENTS.md
├── merge/.pi/agent/settings.json     # only the keys this repository owns
└── emit/pi/                          # the theme, and its fallback
```

## Install

`pkg` installs Node, npm, `fd` and `ripgrep` from the distribution (on Fedora `nodejs-npm` and
`fd-find`). Pi would otherwise download `fd` and `rg` itself. One `npm` recipe then installs Pi
(`@earendil-works/pi-coding-agent`, which needs Node 22.19 or later), `pi-claude-bridge` and
`@juicesharp/rpiv-ask-user-question` under `~/.local/share/pi`, so none of it touches the system's
global npm directory. Nothing is pinned; `othala update` brings the three up to date. npm blocks
the install scripts of two of Pi's dependencies (`@google/genai`, `protobufjs`); Pi works without
them.

`@mariozechner/pi-coding-agent` is the deprecated name of the same package. The bridge and the
question UI do not load on it.

## Offline by default

`~/.local/bin/pi` is a script, not a link to Pi, so the switches hold however Pi is started:

| Variable | Stops |
|---|---|
| `PI_OFFLINE=1` | the model catalog refresh, package installs and update checks at start, the `fd` and `rg` download |
| `PI_SKIP_VERSION_CHECK=1` | the version check |
| `PI_TELEMETRY=0` | the install report and the provider attribution headers |
| `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1` | the same in the Claude Code child the bridge starts |

`enableInstallTelemetry` and `enableAnalytics` are `false` in the settings as well. Because offline
Pi cannot install packages, the module does, and `packages` lists them as paths. Claude Code gets
the two `DISABLE_*` variables in its own `settings.json` `env` too, for use outside Pi.

Anything that needs the network is a command you run: `/login`, `/share`, `pi update`, a provider's
requests.

## Settings

Pi rewrites `~/.pi/agent/settings.json` as it runs: `defaultProvider` and `defaultModel` on
`/model`, `lastChangelogVersion` on first start, `deviceId` on login. A link into this repository
would send those writes into `git diff`, so the file is a real file and the module holds
`merge/.pi/agent/settings.json`. `othala link` sets each key of that file in the real one and
keeps every other key ([the linker](https://gitlab.com/futharkd/othala/cli/-/blob/master/docs/cli.md#the-linker)).
The repository holds only:

| Key | Value |
|---|---|
| `enableInstallTelemetry`, `enableAnalytics` | `false` |
| `packages` | the bridge and the question UI, as `~/.local/share/pi/lib/node_modules/...` paths. Pi resolves `~` in a local path, and a local package is never installed or updated by Pi |
| `skills` | `~/.claude/skills`: the skills `agents-common` shares |
| `theme` | `othala` |
| `compaction` | `enabled`; the token thresholds stay at Pi's defaults |

A key you change in the module replaces the whole value on the machine at the next `link`. Edit a
key it does not name (`/settings`, `/model`) and the change stays. `othala diff` shows a pending
merge.

## Providers and context

| | |
|---|---|
| Claude | `claude auth login`, then `/model` and a `claude-bridge` model. Through the bridge Pi executes the tools; the Claude Code child sees the hooks in `~/.claude/settings.json`, which stays lean for that reason |
| Codex, Gemini | Pi's own `/login` |
| ollama | `models.json`: `openai-completions` at `http://localhost:11434/v1`. It lists no model; add `models` entries with the ids `ollama list` shows |

`~/.pi/agent/AGENTS.md` is a link to the file `agents-common` shares with opencode and Claude Code,
so the rules, the commit rule included, apply to Pi. Pi reads `~/.agents/skills` and
`~/.pi/agent/skills`, not `~/.claude/skills`; the `skills` setting above is what brings the shared
skills in, with no copy.

Pi has no subagents, plan mode or web access of its own, and no permission prompts: the
guardrails extension adds them. MCP servers go in
`~/.pi/agent/mcp.json`, which Pi also rewrites from `/mcp`, so the module does not ship one.

## Guardrails

`extensions/guardrails/` is a global Pi extension, loaded from `~/.pi/agent/extensions`. Its rules
are data in `rules.json`, ported from the `permission` block of opencode's `opencode.json` and from
its `guardrails.js`. Each table reads general to specific and the last matching rule wins, as in
opencode. `*` matches anything, slashes included, and a trailing ` *` also matches the bare
command (`ls *` allows `ls`).

| Table | Decides |
|---|---|
| `tools` | a tool by name: `edit` and `write` ask, the rest allowed |
| `bash` | each simple command, as its words joined by spaces |
| `bashRegex` | destructive commands: forced recursive delete, force-push, push to `master`/`main`/`release/`, `dd of=`, `DROP TABLE` |
| `interpreters`, `opaque` | a pipe into a shell or interpreter is denied; `eval`, `exec`, `source`, `.` and `sh -c` ask |
| `paths` | secrets (`.env`, `*.pem`, `*.key`, SSH keys) are denied, as a tool path and as a word or redirection target of a bash command; `.env.example` is allowed |
| `external` | a path outside the project asks, except `/tmp`, `/var/tmp` and `~/.pi/agent/plans` |

`ask` opens Pi's confirm dialog. With no UI (print and JSON mode) it means deny, and the reason says
so. The strictest verdict across a command list wins. `rules.ts` tokenizes the shell subset (words,
quotes, `&&`, `||`, `;`, `|`, `&`, redirections); a command it cannot parse is denied, and
`$(...)`, backticks, subshells, heredocs and process substitution ask. Parsing stops at such a
construct, so what precedes it is still checked for deny. A redirection to a file outside `/tmp`
and `/dev/null` asks.

Denied tools are removed from the active set at `session_start` and `before_agent_start`, and
`tool_call` blocks them anyway, because codemode can call a tool that is not active. A tool result
over `maxOutputChars` keeps its first and last half with a note of how much was cut.

The commit rule is `agents-common`'s section 11, enforced: a `git commit` whose `-m`, `--message`
or `-F` text holds `Co-Authored-By`, "Generated with", `Claude` (any case) or the words `Pi` or
`AI` is refused. An editor commit, or `-F -`, has no message to read and is allowed. When the
message sits in a `$(cat <<EOF ...)` the whole command text is scanned instead.

`OTHALA_TASK_FILES`, a `:`-separated list of globs relative to the project, confines `edit` and
`write` to those paths. Nothing sets it yet: the `tasks` extension will, for its child runners.
Bash is not confined by it.

The pure logic (`rules.ts`, no Pi imports) is tested by `modules/tools/pi/test/`, which
`.ci/check.sh` runs with `node --test`.

## Theme

The `pi` emitter writes `~/.pi/agent/themes/othala.json` from the colour roles, with all 51
colours Pi requires and the `appearance` of the active scheme. Pi hot-reloads the active user theme,
so a preset switch repaints a running Pi. Until a preset is applied the file is the default
preset's rendering ([fallback outputs](https://gitlab.com/futharkd/othala/cli/-/blob/master/docs/cli.md#the-linker)); JSON has no comments, so
it carries no header. `pi` is a hybrid application in SPECS.md §2.2, with the settings selecting the
theme by name.

## Git

`.pi/plans/` and `.pi/worktrees/` are in the `git` module's global ignore, so no project's
`.gitignore` changes.
