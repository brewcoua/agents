# Extensions

The Pi extensions in `extensions/`, loaded from the package's `pi.extensions` list. Each keeps its
pure logic in files with no Pi imports, tested under `test/` with `node --test`. `extensions/lib/` is
shared code, not an extension.

Installing Pi, its settings, providers and theme are the `pi` module's, in othala config
([`25-pi.md`](https://gitlab.com/futharkd/othala/config/-/blob/master/docs/25-pi.md)).

## Guardrails

`extensions/guardrails/` holds its rules as data, in `rules.json`. Each table reads general to
specific and the last matching rule wins. `*` matches anything, slashes included, and a trailing ` *` also matches the bare
command (`ls *` allows `ls`).

| Table | Decides |
|---|---|
| `tools` | a tool by name: all allowed |
| `bash` | each simple command, as its words joined by spaces |
| `bashRegex` | destructive commands: forced recursive delete, force-push, push to `master`/`main`/`release/`, `dd of=`, `DROP TABLE` |
| `interpreters`, `opaque` | a pipe into a shell or interpreter is denied; `eval`, `exec`, `source`, `.` and `sh -c` ask |
| `paths` | secrets (`.env`, `*.pem`, `*.key`, SSH keys) are denied, as a tool path and as a word or redirection target of a bash command; `.env.example` is allowed |
| `external` | a read outside the project asks, except under `/tmp` and `/var/tmp` |

`ask` opens Pi's confirm dialog. With no UI (print and JSON mode) it means deny, and the reason says
so. The strictest verdict across a command list wins. `rules.ts` tokenizes the shell subset (words,
quotes, `&&`, `||`, `;`, `|`, `&`, redirections); a command it cannot parse is denied, and
`$(...)`, backticks, subshells, heredocs and process substitution ask. Parsing stops at such a
construct, so what precedes it is still checked for deny. A redirection to a file outside `/tmp`
and `/dev/null` asks.

`/guardrails` lists what was refused or asked about in this Pi, newest first (up to 200), with the outcome:
denied by a rule, refused for lack of a UI, or allowed or declined by you. Enter shows the full command and the
reason. The list lives in memory only.

Denied tools are removed from the active set at `session_start` and `before_agent_start`, and
`tool_call` blocks them anyway, because codemode can call a tool that is not active. A tool result
over `maxOutputChars` keeps its first and last half with a note of how much was cut.

The commit rule is section 11 of `AGENTS.md`, enforced: a `git commit` whose `-m`, `--message`
or `-F` text holds `Co-Authored-By`, "Generated with", `Claude` (any case) or the words `Pi` or
`AI` is refused. An editor commit, or `-F -`, has no message to read and is allowed. When the
message sits in a `$(cat <<EOF ...)` the whole command text is scanned instead.

`edit` and `write` inside the project directory (Pi's working directory) are allowed without
asking, the plan files under `.pi/plans/` included. Outside it they always ask, `/tmp` included,
whatever `external` says.

Each agent session ([Agents](#agents)) loads its own guardrails, with the settings below; they
are not environment variables, since agents share Pi's process. An agent has no UI, so `ask` means
deny there.

- A type's `bash` list: every command of a bash line must start with one of its entries, such as
  `git log`, or the line is denied; the normal rules still apply to what passes.
- A task agent's files, globs relative to its worktree, allow `edit` and `write` to those paths and
  refuse every other path; the refusal tells the model to call `request_files` (see Running tasks).
  Its verify command is allowed when a bash command equals it, as is a line of only `git add <paths>`
  where every path is one of the task's files, and `git commit`, to which the commit rule still
  applies. Bash is otherwise not confined by the files; the land step checks the diff.

## Extensions

### lsp

After a successful `edit` or `write`, appends the file's errors (and up to 5 warnings) from a language server: rust-analyzer, lua-language-server, pyright (or basedpyright), typescript-language-server, gopls, clangd or bash-language-server. It uses only servers already on PATH and never installs one. One server process runs per workspace root, started on first use and stopped when the session ends. If a cold server does not answer within 10 seconds (`OTHALA_LSP_TIMEOUT_MS`), the result says "no diagnostics yet". Diagnostics are the ones servers push; a server that only answers pull requests gives none.

### memory

Markdown memory that survives sessions, kept the way Claude Code keeps its own: one fact per file, plus an index.

- Global memories are in `~/.pi/agent/memory/`, project memories in `<project>/.pi/memory/`. Commit the project directory or ignore it, as you prefer; the global ignore does not list it.
- Each memory is `<name>.md` with frontmatter (`name`, `description`, `type`: user, feedback, project or reference) and a body. `MEMORY.md` in the same directory holds one line per memory.
- Tools: `memory_save` (create, or replace the memory of the same name) and `memory_forget`.
- `/memory` lists both directories' memories (scope, type, name, description). Enter shows a memory's file; `d`, pressed twice, deletes it and its index line.
- Each request carries the two `MEMORY.md` indexes as a leading user message, never stored in the session. The model reads a memory file with `read` when its line matters.
- Pi offers no hook to add a turn to a compaction. So when a run ends with the context at 80% or more, the extension asks the model once, in a hidden message, to save what is worth keeping. It makes no model call of its own, and does nothing on exit. A manual `/compact` gets no such reminder.

### btw

`/btw <question>`, or `ctrl+alt+b`, asks a quick question in a separate, read-only session while the main agent keeps running. The side session runs in-process (the SDK's `createAgentSession`, an in-memory session) on the main session's current model, with only `read`, `grep`, `find` and `ls`. It loads only the guardrails extension, so the same path rules apply; what guardrails would ask about is refused, since the side session has no UI. It sees the last 20000 characters of the main conversation's text. The answer streams into an overlay; Esc closes it. The exchange is never added to the main session's history or saved to a file. It needs the interactive TUI.

### simplify

`/simplify [ref]` runs `git diff` in the session directory (against `HEAD`, so staged and unstaged changes, or against `ref`) and asks the model to apply the `simplify` skill to it. An empty diff prints a notice and sends nothing. A diff over 60000 characters is cut at file boundaries, and the message names the files left out. Untracked files are not in `git diff`. The skill is `skills/simplify`; it lists cuts and applies none unless asked.

### models-discovery

Lists the models of an OpenAI-compatible server at start-up and registers them with Pi. A provider in `~/.pi/agent/models.json` opts in with `"modelsDiscovery": true`, a key Pi itself ignores; the `pi` module's ollama provider does. It calls `GET <baseUrl>/models`, then ollama's `POST /api/show` on the same host for each model, for the context length and the vision and thinking capabilities. Models listed in models.json win over discovered ones. It talks only to the configured host, with a 3 second timeout. With the host down, nothing is added and nothing is printed; `OTHALA_DEBUG=1` says why.

A discovered model gets an output cap of 64K tokens, since ollama reports none and Pi's default of 16K is too low for coding. A cloud model (`<name>:cloud`, or `<name>-cloud` as in `gpt-oss:120b-cloud`) gets its per-million price from `extensions/models-discovery/prices.json`, by name, so the budget's dollar cap counts ollama cloud; a local model costs 0. Off-peak prices are left out: the extension does not know the clock they follow.

### advisor

The `advisor` tool takes no parameters. It sends the session's context, compactions included, to
the active profile's `top` model ([Profiles](#profiles)) and returns its advice: a plan, a
correction, or a signal to stop and ask the user. The advisor gets no tools: the tool declarations
are removed from the context, as is the `advisor` call that is running, and a user turn is added
when the context ends on the model's. It follows `rpiv-advisor`'s handoff, without its model picker.

The call goes through Pi's model registry, which applies each provider's credentials, OAuth
included. Its cost counts against the session's budget under `advisor`. While the session itself
runs on the `top` model, the tool is not offered. An unknown `top` model, missing credentials or a
failed call come back as the tool's text.

### ask

The `ask_user_question` tool: the model asks up to 4 questions, each with 2 to 4 options, and gets
the answers back as text. It takes the parameters, error codes and result text of
`rpiv-ask-user-question` 2.15, so a model that knows that tool calls this one unchanged.

The dialog has a tab per question, and a Submit tab when there are several; `←`/`→` or `Tab` move
between them. `↑`/`↓` move through a question's options; `Enter` picks one, or on a `multiSelect`
question confirms the options toggled with `Space` (the focused one when none is). The last row,
`Type something.`, takes a typed answer. An option's `preview` shows below the list while it is
focused. Submit sends what is answered and names the questions left blank; `Esc` cancels, and the
model reads `User declined to answer questions`.

Options labelled `Other`, `Type something.` or `Next` are refused, as are duplicate questions or
labels. `questions` sent as a JSON string is decoded first, as some tool-call parsers send it. The
dialog needs the interactive TUI: in print, JSON and RPC mode the tool is removed from those the
model sees, and a call that still arrives returns an error telling the model to ask in chat.

### budget

Caps spend per session. It adds up cost and tokens (`input + output`) from each assistant message's usage, which is the cost Pi shows in its footer. It warns once at 25, 50 and 75% of the nearer cap. At 100% it blocks every further tool call with a reason telling the model to report and stop. Set `PI_BUDGET_USD` (default 2) and `PI_BUDGET_TOKENS` (default 5000000); 0 disables a cap. A model with no catalog price, such as the Claude bridge on a subscription, records a cost of 0, so only the token cap applies to it. There is no cap on output tokens per request; use `maxTokens` in models.json. A resumed or forked session starts from what its history already spent.

Usage of the sessions this one starts counts against the same caps: each agent under `agent:<type>`, task agents and `/plan` scouts included (`agent:task`, `agent:plan-scout`), and `/btw` (`btw`). Each adds up its session's messages as they end. Each figure is stored in the session as a `budget-usage` entry, so a resume counts it again.

The status line shows `budget 12% · 610k/5M tok`, with the dollar figure when something cost more than 0. `/budget` shows the caps, this session's own usage, each source above, and the total.

### usage

Shows how much of each subscription is left, and what was spent. It sends no request of its own: it
reads the rate-limit figures providers put on their responses, and writes them, per provider, to
`~/.pi/agent/othala-usage.json`, which every Pi on the machine shares.

| Provider | Where the figures come from |
|---|---|
| Claude (bridge) | the `anthropic-ratelimit-unified-*` headers the bridge rebuilds from Claude Code's rate-limit events: the 5-hour and 7-day windows, used as a fraction, reset in Unix seconds |
| Codex | the `x-codex-primary-*` and `x-codex-secondary-*` headers, or the `codex.rate_limits` stream event: used percent, window in minutes, reset in Unix seconds. Read from the Codex CLI's parser, not yet seen from Pi |
| others | any header whose name has `ratelimit`, `rate-limit` or `quota`, kept as it came, so the format shows in `/usage` before anything parses it |

The status line shows the windows of the current model's provider, `5h 0% · 7d 8%`. `/usage` lists
each provider's last report, dimmed after a day, with the reset times on `Enter`; then the tokens
and cost of the last 24 hours, 7 days and 30 days, by model, read from the session files under
`~/.pi/agent/sessions`, and by source for the agents and `/btw` the budget recorded. A message's cost is the one recorded when it ran, 0 for the
bridge. The list refreshes every 5 seconds and sits over the editor; a run carries on underneath.

### ui

Replaces Pi's startup header and three-line footer with one line each, in the theme's colours.

The header reads `pi 1.5.2  6 skills  / commands · ! bash · esc interrupt · ctrl+c clear · ctrl+d
exit`. The footer reads, left to right: the project directory and git branch, the context window's
fill, the other extensions' statuses (`plan` and `tasks` first, plan mode in the warning colour),
then, flush right, the model, its thinking level and the active profile:

```text
cli master │ ctx 4% │ budget 0% · 21/5M tok │ 5h 13% · 7d 10%          claude-opus-5-5 · medium  claude
```

Every percentage is green under 50, yellow from 70 and red from 90. On a narrow terminal the left
parts drop from the end, then the model is cut. Pi's token and cache counters are not shown; spend
is in `/budget` and `/usage`. Only the interactive TUI gets either line.

### web

Three tools; none clicks, types or logs in.

| Tool | Does |
|---|---|
| `web_search` | Searches through the `searxng` module's local SearXNG ([`26-searxng.md`](https://gitlab.com/futharkd/othala/config/-/blob/master/docs/26-searxng.md)) and returns title, URL, date and snippet for up to 30 results (default 8). `category` is `general`, `it`, `news` or `science`; `engines` names engines to search instead, including those off by default ([`26-searxng.md`](https://gitlab.com/futharkd/othala/config/-/blob/master/docs/26-searxng.md#engines)). It names the engines that did not answer, and leaves out results whose URL has no host. Without the module it says how to start it |
| `web_fetch` | Fetches an `http(s)` URL. HTML comes back as Markdown-like text, the `<main>` or `<article>` only when the page has one; text, JSON and XML as they are; anything else (a PDF, an image) is saved under `/tmp/pi-web-*/` and its path returned, for the `documents` skill; that directory is deleted when the session ends. A body over 50 MB is refused. Text comes in windows of 20000 characters, and the result gives the `offset` to read on |
| `web_render` | Loads the URL in headless chromium, runs its JavaScript for up to 10 seconds of page time, and returns the text the same way, or with `screenshot` a PNG of the viewport (default 1280 by 1600). Registered only when `chromium` (or Fedora's `chromium-browser`) is on PATH; the `searxng` module installs it |

The tools make requests only when the model calls them. chromium runs with a fresh profile per call,
deleted after, and with its own background requests (component updates, sync, metrics) turned off.
Guardrails allows all three, as it allows `curl`.

## Profiles

`profiles.json` maps each provider profile to three models, one per role, as `provider/model`:

| Role | Used by |
|---|---|
| `top` | the session after a switch, `/plan`, the `advisor` tool |
| `large` | `large` tasks, and the third attempt of a failing task |
| `small` | scouts, `small` tasks |

| Profile | `top` | `large` | `small` |
|---|---|---|---|
| `claude` | `claude-bridge/claude-opus-5-5` | `claude-bridge/claude-sonnet-5-5` | `claude-bridge/claude-haiku-5-5` |
| `codex` | `openai-codex/gpt-6.1-sol` | `openai-codex/gpt-6.1-terra` | `openai-codex/gpt-6-luna` |
| `copilot` | `github-copilot/gpt-6-luna` | `github-copilot/gpt-5.6-luna` | `github-copilot/mai-code-1.1-flash` |
| `ollama` | `ollama/kimi-k3.1-pro:cloud` | `ollama/glm-5.3:cloud` | `ollama/glm-5.3-flash:cloud` |

`/provider <name>` switches the session to the profile's `top` model and stores the profile and the
model of each role in `~/.pi/agent/othala-profile.json`, which tasks and scouts read. A role whose
model Pi does not know keeps the model it had, and the command says so; for ollama it gives the
`ollama pull` line. A profile whose `top` model has no credentials is refused. `/provider` alone
shows the active profile, each role's model, and whether Pi has credentials for it. With no state
file, the first profile of `order` is active.

When a run ends on an error that reads as an exhausted quota or a rate limit, the extension offers
the next profile of `order` (`claude`, `codex`, `copilot`, `ollama`) and switches only on a yes. The
match (`429`, "rate limit", "usage limit", "quota", "too many requests") is not checked against each
provider's real errors yet.

## Tasks

The `tasks` extension plans before it builds, then runs the plan's tasks in git worktrees, each as an
agent ([Agents](#agents)), so the fleet shows them. Planning and review come first; a small change is implemented in the same session.

### Roles

A task's `role` (`small` or `large`) is a role of the active profile ([Profiles](#profiles)), and
`/plan` uses `top`. At most `maxConcurrent` of `profiles.json` tasks run at once.

### Planning

`/plan <request>` switches to the `top` model and tells it that it is planning. The session is then
read-only: `edit` and `write` are refused outside `.pi/plans/`, and `bash` runs only what guardrails
allow without asking. An `ask` verdict counts as a refusal here, since the model has nobody to ask.
Other tools (memory, MCP, codemode) are refused too. The model asks you with `ask_user_question`,
researches with `read`, `grep`, `find`, `ls` and `scout`, and writes `.pi/plans/<slug>.md`.

`scout` takes up to 6 questions and starts one `plan-scout` agent per question, in parallel, on the
`small` role, with only `read`, `grep`, `find` and `ls`. Each has 180 seconds and its answer is cut
at 8000 characters; a failed scout reports its error. Scouts need the agents extension.

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

## Acceptance
- a1: `cargo test --test dnf` exits 0
- a2: manual: `othala --help` names dnf
- a3: deferred: no Fedora CI yet

## Tasks
### 3.1 dnf backend
- deps: 2
- files: src/pkg.rs, tests/dnf.rs
- tests: tests/dnf.rs
- role: small
- mode: tdd
- spec: dnf installs the listed packages; an empty list runs nothing
- verify: cargo test pkg::
- covers: a1, a2
```

`status` is `draft` or `approved`. An acceptance item is `` `<command>` exits 0 ``, `manual: <check>`,
or `deferred: <reason>`. A task is `### <id> <title>` plus:

| Field | Value |
|---|---|
| `deps` | ids of tasks that land first, comma separated |
| `files` | paths or globs the task may change, comma separated |
| `tests` | the subset of `files` holding the task's tests; required for `tdd` |
| `role` | `small` or `large` |
| `mode` | `tdd`, or `direct: <reason>` for work no test can describe |
| `spec` | the behaviours the tests must show, in words |
| `verify` | one command that fails until the task is done |
| `covers` | the acceptance ids the task makes pass |
| `parent` | an id like `3.1` has parent `3` unless set |

`files`, `role`, `mode`, `spec` and `verify` are required; ids are unique and `deps` must exist. When the
plan has tasks, every acceptance item that is not deferred is covered by one, and `covers` names only
acceptance items. A plan with one task, or no `## Tasks`, is a small change.

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
`/tasks status [slug]` prints each task's status, and `/tasks stop` stops a run. `/tasks [slug]` opens a view of
the task file, read again each second: each task's status and failed attempts; Enter shows its files, verify
command, granted files and notes; `s`, pressed twice, stops the run when this Pi is running it. They want the TUI or RPC: Pi
does not run extension commands in print mode. A run goes on in the background, with its progress in the status
line, so the session stays usable meanwhile. One run at a time per project: `.pi/worktrees/run.lock` holds the
pid of the Pi running it. The plan file gains an optional `## Finish` section, one line holding the command that runs the
project's full tests. The run goes through these steps:

1. Compile. The plan becomes `.pi/plans/<slug>.json`: the plan's title, goal, decisions, finish command and acceptance,
   and each task with `status` (`pending`, `running`, `review`, `done`, `failed`), and `attempts` and `notes`
   after a failure. The file is the state. Compiling refuses unknown dependencies, a cycle, and two tasks that
   are not ordered by `deps` and have overlapping `files`, naming the overlap. Two globs are taken to overlap
   unless their fixed beginnings or endings differ.
2. Execute. A task is ready when it is pending and its dependencies are done; a batch is up to `maxConcurrent`
   ready tasks, which compiling made disjoint. Each gets `git worktree add .pi/worktrees/<id> -B pi-task-<id> HEAD`
   (characters git dislikes in the id become `_`) and a `task` agent there on the task's role, whose prompt
   is the plan's goal and decisions plus the task's title, spec, mode, files, tests and verify command. The agent
   edits, runs verify, and commits in its worktree, under guardrails holding the task's files and verify
   command (see Guardrails). With `sccache` on PATH, its bash and the verify command get
   `RUSTC_WRAPPER=sccache`, so Cargo's per-worktree `target/` shares compiles; other languages need nothing.
   An agent has 30 minutes. `/tasks run` needs the agents extension.

   An agent that needs a file outside its `files` calls `request_files` with the paths and a reason, and ends.
   The runner grants it when no task that may run at the same time (not done, not ordered with it by `deps`)
   has an overlapping file, adds the paths to the task's `files` and its `granted` list, and starts an agent
   again in the same worktree, without a reset, with the answer in its prompt. Otherwise the answer is a refusal
   naming the other task. Nobody is asked. Three requests per task are answered; a fourth ends the attempt.
3. Check. No model reads the diff: the parent checks that nothing is uncommitted, that there is a commit,
   that every file in `git diff --name-only <base> HEAD` matches the task's `files`, and re-runs the verify
   command in the worktree. A failure goes back to a fresh worktree and a new agent with the failure as notes.
   Two failures on the task's role give a third attempt on `large`; after that the task is `failed`, the run
   stops, and its worktree stays for you to look at.
4. Land. The batch's passing tasks land one at a time: the task's branch is rebased onto the current HEAD in
   its worktree, then the current branch is fast-forwarded to it, so HEAD moves once or not at all. Then the
   worktree and its branch are removed. A rebase that does not apply is aborted and fails the task. Later
   batches branch from the new HEAD, so they see their dependencies.
5. Finish. When every task is done, the `## Finish` command runs in the project; if it fails the run stays open and
   `/tasks run` repeats it. Then the plan file is marked `status: done` and a summary of the tasks is shown.

`/tasks run` on a plan that stopped puts `running`, `review` and `failed` tasks back to `pending` with their
attempts reset, and starts them over: their worktrees are reset to the new base without asking, and recreated
when a killed `git` left them locked. A failed task's worktree is there to look at only until then.

Every process a task's agent or verify command starts carries `OTHALA_TASK_TREE=<project>#<task>` in its
environment, inherited by what it starts in turn. Stopping kills each process whose `/proc/<pid>/environ` holds
that marker, so what an agent started in its own process group or session goes too, and a shell you opened in a
worktree does not. The agents themselves live in Pi's process. The moments it runs:

| When | What stops |
|---|---|
| `/tasks stop` | the task agents and everything they started; tasks that already passed their checks still land, nothing new starts |
| Pi quits, or the session is replaced | the same, at `session_shutdown` |
| Pi is killed | the agents, with Pi; a verify or finish command at once, by the kernel, since it runs under `setpriv --pdeathsig KILL` (util-linux). What they started is stopped at the next Pi start in the project, unless another Pi holds the lock |
| `/tasks run` | whatever an earlier run left, before it starts |
| An agent passes 30 minutes | that agent and that task's processes |

`.pi/plans/` and `.pi/worktrees/` are in the `git` module's global ignore in config, so no project's
`.gitignore` changes.

## Agents

The `agents` extension gives the model subagents: each is a separate Pi session in this process, with
its own context, tools and model, that works on one prompt and returns its final answer.

### Agent types

A type is a Markdown file: frontmatter, then the prompt, appended to the agent's system prompt.

```markdown
---
name: locate
description: Finds where a symbol is defined. The model reads this to pick a type.
role: small
tools: [read, grep, find, ls]
max_turns: 20
---

You locate code. ...
```

| Field | Default | Meaning |
|---|---|---|
| `name`, `description` | required | |
| `role` | `large` | `top`, `large` or `small`: the model is that role of the active profile ([Profiles](#profiles)) |
| `tools` | every tool | an allowlist; `web_search`, `web_fetch` and `web_render` load the `web` extension |
| `bash` | any command | command prefixes such as `git log`: every command the agent runs must start with one ([Guardrails](#guardrails)) |
| `max_turns` | 50 | after it, the agent is told to wrap up; 3 turns later it is stopped |
| `isolation` | `off` | `worktree`: it works in `.pi/worktrees/agent-<id>` on branch `agent-<id>`, committed when it ends |
| `allowed_agents` | none | the types it may start itself; agents nest 2 deep |

Types are read from `.pi/agents/` in the project, then `~/.pi/agent/agents/`, then the package's
`agents/`; the first file with a name wins. `/agents` lists them with their role, tools and file, and
`e` opens one in your editor. A file that does not parse is listed as skipped, with the reason.

The package's types:

| Type | Role | Does |
|---|---|---|
| `locate` | small | finds definitions, callers and uses; a `path:line` table |
| `scout` | small | answers one external question from docs and the web, with sources |
| `research` | large | splits a broad question, starts `scout`, `locate` and `precedent` agents, writes the synthesis |
| `review` | large | reviews a diff: one line per finding, `blocker`, `major` or `minor`, quoting the line |
| `implement` | large | does one specified subtask and runs the narrowest check |
| `precedent` | small | finds similar past commits in git history and the fixes that followed them |
| `verify-claims` | small | tags each claim about the code Verified, Weakened or Falsified, citing `file:line` |

`precedent` and `verify-claims` are adapted from rpiv's `precedent-locator` and `claim-verifier`
([rpiv-mono](https://github.com/juicesharp/rpiv-mono), MIT, Copyright (c) 2026 juicesharp).

`precedent` and `verify-claims` have `bash` lists of git reads. `review` has none, but an agent
cannot ask, so its `bash` runs only what guardrails allow without asking.

### Starting agents

The model calls `agent` with a `type`, a self-contained `prompt` and a short `description`.

- **Background** is the default: the tool returns the agent's id and handle at once, and the result
  arrives as a message that starts your next turn. With `background: false` the call waits for it.
  In print mode every agent runs in the foreground, since Pi exits after its turn.
- `agent_result` reads an agent's state, or with `wait`, blocks until it ends. `agent_steer` sends a
  running agent a message it reads after its current tool call.
- `resume` with an ended agent's id or handle continues it in its own context with a new prompt.
  Agents are saved next to the session, so they can be resumed after Pi restarts (`pi -c`). A
  worktree agent cannot be resumed while its worktree has uncommitted changes.
- `inherit_context: true` starts the agent from a copy of this conversation instead of an empty one.
- `model` (`provider/model`), `thinking`, `max_turns`, `isolation` and `name` override the type.

At most `maxConcurrent` of `profiles.json` agents run at once per nesting level; the rest queue. An
agent with children waits for its background children before it ends, and gets their results as
its next prompt. Stopping an agent stops its children, and kills the processes its `bash` started,
found by `OTHALA_TASK_TREE=<project>#agent-<id>` as for tasks. Agents stop when the session ends.

### The fleet

While an agent runs, a line above the editor shows its handle, current tool, tokens and context use.
Below the editor, the fleet lists every agent of the session as a tree.

| Key | Where | Does |
|---|---|---|
| `↓` | empty prompt | selects the fleet; `↑` and `↓` move, `Esc` leaves |
| `Enter` | fleet | opens the agent's transcript, which follows it as it works |
| `Enter` | transcript | asks for a message and steers the agent with it |
| `x` `x` | fleet, transcript | stops the agent and its children |
| `b` | fleet, transcript | moves a foreground agent to the background |
| `ctrl+b` | prompt | moves every foreground agent to the background; cursor-left otherwise |

A prompt `@<handle> <message>` steers that agent when it runs and resumes it when it has ended. A
word after `@` that is no agent's handle, such as a file reference, leaves the prompt alone.
