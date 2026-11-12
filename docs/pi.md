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
│       ├── tasks.json                # the model tiers of the tasks extension
│       ├── extensions/guardrails/    # allow, ask and deny rules; rules.json holds them
│       ├── extensions/{lsp,memory,btw,simplify,models-discovery,budget,tasks}/
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
| ollama | `models.json`: `openai-completions` at `http://localhost:11434/v1`. It lists no model; the models-discovery extension registers what the server has |

`~/.pi/agent/AGENTS.md` is a link to the file `agents-common` shares with opencode and Claude Code,
so the rules, the commit rule included, apply to Pi. Pi reads `~/.agents/skills` and
`~/.pi/agent/skills`, not `~/.claude/skills`; the `skills` setting above is what brings the shared
skills in, with no copy.

Pi has no subagents, plan mode or web access of its own, and no permission prompts; the
guardrails extension adds those. MCP servers go in
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
| `external` | a path outside the project asks, except `/tmp` and `/var/tmp` |

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

`edit` and `write` under `<project>/.pi/plans/` are allowed without asking, in every session: the
`tasks` extension has the model write its plan and task files there, including in print mode, where
nothing could answer.

The `tasks` extension starts each task's child `pi` with two variables, and guardrails then runs in
task mode. `OTHALA_TASK_FILES`, a `:`-separated list of globs relative to the project, allows `edit`
and `write` to those paths and refuses every other path. `OTHALA_TASK_VERIFY` is the task's verify
command: a bash command equal to it is allowed, as is `git add <paths>` where every path is one of
the task's files, and `git commit`, to which the commit rule still applies. Everything else follows
the normal rules, and `ask` means deny, since a child has nobody to answer. Bash is otherwise not
confined by `OTHALA_TASK_FILES`; the land step checks the diff.

The pure logic (`rules.ts`, no Pi imports) is tested by `modules/tools/pi/test/`, which
`.ci/check.sh` runs with `node --test`.

## Extensions

The other extensions in `~/.pi/agent/extensions/`, each with its pure logic tested the same way.

### lsp

After a successful `edit` or `write`, appends the file's errors (and up to 5 warnings) from a language server: rust-analyzer, lua-language-server, pyright (or basedpyright), typescript-language-server, gopls, clangd or bash-language-server. It uses only servers already on PATH and never installs one. One server process runs per workspace root, started on first use and stopped when the session ends. If a cold server does not answer within 10 seconds (`OTHALA_LSP_TIMEOUT_MS`), the result says "no diagnostics yet". Diagnostics are the ones servers push; a server that only answers pull requests gives none.

### memory

Markdown memory that survives sessions, kept the way Claude Code keeps its own: one fact per file, plus an index.

- Global memories are in `~/.pi/agent/memory/`, project memories in `<project>/.pi/memory/`. Commit the project directory or ignore it, as you prefer; the global ignore does not list it.
- Each memory is `<name>.md` with frontmatter (`name`, `description`, `type`: user, feedback, project or reference) and a body. `MEMORY.md` in the same directory holds one line per memory.
- Tools: `memory_save` (create, or replace the memory of the same name) and `memory_forget`.
- Each request carries the two `MEMORY.md` indexes as a leading user message, never stored in the session. The model reads a memory file with `read` when its line matters.
- Pi offers no hook to add a turn to a compaction. So when a run ends with the context at 80% or more, the extension asks the model once, in a hidden message, to save what is worth keeping. It makes no model call of its own, and does nothing on exit. A manual `/compact` gets no such reminder.

### btw

`/btw <question>`, or `ctrl+alt+b`, asks a quick question in a separate, read-only session while the main agent keeps running. The side session runs in-process (the SDK's `createAgentSession`, an in-memory session) on the main session's current model, with only `read`, `grep`, `find` and `ls`. It loads only the guardrails extension, so the same path rules apply; what guardrails would ask about is refused, since the side session has no UI. It sees the last 20000 characters of the main conversation's text. The answer streams into an overlay; Esc closes it. The exchange is never added to the main session's history or saved to a file. It needs the interactive TUI.

### simplify

`/simplify [ref]` runs `git diff` in the session directory (against `HEAD`, so staged and unstaged changes, or against `ref`) and asks the model to apply the `simplify` skill to it. An empty diff prints a notice and sends nothing. A diff over 60000 characters is cut at file boundaries, and the message names the files left out. Untracked files are not in `git diff`. The skill lives in agents-common (`~/.claude/skills/simplify`), so Claude Code and opencode have it too; it lists cuts and applies none unless asked.

### models-discovery

Lists the models of an OpenAI-compatible server at start-up and registers them with Pi. A provider in `~/.pi/agent/models.json` opts in with `"modelsDiscovery": true`, a key Pi itself ignores; the module's ollama provider does. It calls `GET <baseUrl>/models`, then ollama's `POST /api/show` on the same host for each model, for the context length and the vision and thinking capabilities. Models listed in models.json win over discovered ones. It talks only to the configured host, with a 3 second timeout. With the host down, nothing is added and nothing is printed; `OTHALA_DEBUG=1` says why.

### budget

Caps spend per session. It adds up cost and tokens (`input + output`) from each assistant message's usage, which is the cost Pi shows in its footer. It warns once at 25, 50 and 75% of the nearer cap. At 100% it blocks every further tool call with a reason telling the model to report and stop. Set `PI_BUDGET_USD` (default 2) and `PI_BUDGET_TOKENS` (default 5000000); 0 disables a cap. A model with no catalog price, such as the Claude bridge on a subscription, records a cost of 0, so only the token cap applies to it. There is no cap on output tokens per request; use `maxTokens` in models.json. Totals reset when the session starts, resumes or forks.

## Tasks

The `tasks` extension plans before it builds, then runs the plan's tasks in git worktrees, each in a
child `pi`. Planning and review come first; a small change is implemented in the same session.

### Tiers

`~/.pi/agent/tasks.json` names three models as `provider/model` and a concurrency for the task runner.
Pi never rewrites the file, so it is a link and not part of `settings.json`:

```json
{ "plan": "claude-bridge/claude-opus-5-5", "large": "claude-bridge/claude-sonnet-5-5",
  "small": "claude-bridge/claude-haiku-5-5", "maxConcurrent": 3 }
```

The defaults are the newest Opus, Sonnet and Haiku of the Claude bridge. Any provider works, an
ollama model for `small` included.

### Planning

`/plan <request>` switches to the `plan` model and tells it that it is planning. The session is then
read-only: `edit` and `write` are refused outside `.pi/plans/`, and `bash` runs only what guardrails
allow without asking. An `ask` verdict counts as a refusal here, since the model has nobody to ask.
Other tools (memory, MCP, codemode) are refused too. The model asks you with `ask_user_question`,
researches with `read`, `grep`, `find`, `ls` and `scout`, and writes `.pi/plans/<slug>.md`.

`scout` takes up to 6 questions and runs one child `pi` per question, in parallel, on the `small`
model: print mode, `--no-session`, only `read`, `grep`, `find`, `ls`, no MCP, and `-na`, so a
project's own extensions and settings are not loaded. Each has 180 seconds and its answer is cut at
8000 characters; a failed scout reports its error. The child is the `pi` on PATH, the wrapper, so it
stays offline.

`/plan cancel` leaves plan mode without approving. Leaving restores the model you were using. Plan mode
survives a resume.

### The plan file

```markdown
---
status: draft
---
# <title>

## Goal
## Decisions
## Open questions

## Tasks
### 3.1 dnf backend
- deps: 2
- files: src/pkg.rs
- tier: small
- verify: cargo test pkg::
- accept: dnf installs the listed packages
```

`status` is `draft` or `approved`. A task is `### <id> <title>` plus `deps`, `files` (comma separated),
`tier` (`small` or `large`), `verify`, `accept` and an optional `parent` (an id like `3.1` has parent `3`
unless set). All but `deps` and `parent` are required; ids are unique and `deps` must exist. These are the
fields of the task JSON in the plan-modules workflow. A plan with one task, or no `## Tasks`, is a small change.

### Review

`/plan review` opens the plan in your editor (`externalEditor` in the settings, else `$VISUAL`, `$EDITOR`)
and hands the terminal over until it exits, as Pi's own `ctrl+g` does. A comment is a line starting with
`>>` under the lines it is about, which are quoted with `>`. On save, each comment goes to the model with
its quoted lines, and the model revises the plan and deletes the quotes. Run `/plan review` again for
the next round. Without comments it says so.

In nvim, select lines in a plan under `.pi/plans/` and press `,c`: they become a `>` quote with a `>> `
line under them, in insert mode.

### Approval

`/plan approve` checks that the plan parses, sets `status: approved`, leaves plan mode and restores the
model. A small plan is then implemented in the same session. A plan with several tasks stays approved
for `/tasks run`. `/plan approve` also compiles it (below), so a plan that cannot run is refused with the
reason and stays a draft; an approved multi-task plan starts running at once.

### Running tasks

`/tasks run [slug]` runs an approved plan, or resumes one; without a slug it takes the only open plan.
`/tasks status [slug]` prints each task's status. Both want the TUI or RPC: Pi does not run extension commands
in print mode. The plan file gains an optional `## Finish` section, one line holding the command that runs the
project's full tests. The run goes through these steps:

1. Compile. The plan becomes `.pi/plans/<slug>.json`: the plan's title, goal, decisions and finish command,
   and each task with `status` (`pending`, `running`, `review`, `done`, `failed`), and `attempts` and `notes`
   after a failure. The file is the state. Compiling refuses unknown dependencies, a cycle, and two tasks that
   are not ordered by `deps` and have overlapping `files`, naming the overlap. Two globs are taken to overlap
   unless their fixed beginnings or endings differ.
2. Execute. A task is ready when it is pending and its dependencies are done; a batch is up to `maxConcurrent`
   ready tasks, which compiling made disjoint. Each gets `git worktree add .pi/worktrees/<id> -B pi-task-<id> HEAD`
   (characters git dislikes in the id become `_`) and a child `pi` there: `pi -p --no-session --no-mcp -na`
   on the tier's model, whose only prompt is the plan's goal and decisions plus the task's title, files, verify
   command and accept line. The child edits, runs verify, and commits in its worktree, with `OTHALA_TASK_FILES`
   and `OTHALA_TASK_VERIFY` set (see Guardrails). With `sccache` on PATH, `RUSTC_WRAPPER=sccache` is set too, so
   Cargo's per-worktree `target/` shares compiles; other languages need nothing. A child has 30 minutes.
3. Check. No model reads the diff: the parent checks that nothing is uncommitted, that there is a commit,
   that every file in `git diff --name-only <base> HEAD` matches the task's `files`, and re-runs the verify
   command in the worktree. A failure goes back to a fresh worktree and a new child with the failure as notes.
   Two failures on the task's tier give a third attempt on `large`; after that the task is `failed`, the run
   stops, and its worktree stays for you to look at.
4. Land. The batch's passing tasks are cherry-picked onto the current branch one at a time, then the worktree
   and its branch are removed. A cherry-pick that does not apply is aborted and fails the task. Later batches
   branch from the new HEAD, so they see their dependencies.
5. Finish. When every task is done, the `## Finish` command runs in the project; if it fails the run stays open and
   `/tasks run` repeats it. Then the plan file is marked `status: done` and a summary of the tasks is shown.

`/tasks run` on a plan that stopped puts `running`, `review` and `failed` tasks back to `pending` with their
attempts reset. Their worktrees are listed and you are asked before they are discarded; with no UI nothing
is deleted and the list is the message.

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
