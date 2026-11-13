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

The `tasks` extension starts each task's child `pi` with two variables, and guardrails then runs in
task mode. `OTHALA_TASK_FILES`, a `:`-separated list of globs relative to the project, allows `edit`
and `write` to those paths and refuses every other path; the refusal tells the model to call
`request_files` (see Running tasks). `OTHALA_TASK_VERIFY` is the task's verify
command: a bash command equal to it is allowed, as is `git add <paths>` where every path is one of
the task's files, and `git commit`, to which the commit rule still applies. Everything else follows
the normal rules, and `ask` means deny, since a child has nobody to answer. Bash is otherwise not
confined by `OTHALA_TASK_FILES`; the land step checks the diff.

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

### budget

Caps spend per session. It adds up cost and tokens (`input + output`) from each assistant message's usage, which is the cost Pi shows in its footer. It warns once at 25, 50 and 75% of the nearer cap. At 100% it blocks every further tool call with a reason telling the model to report and stop. Set `PI_BUDGET_USD` (default 2) and `PI_BUDGET_TOKENS` (default 5000000); 0 disables a cap. A model with no catalog price, such as the Claude bridge on a subscription, records a cost of 0, so only the token cap applies to it. There is no cap on output tokens per request; use `maxTokens` in models.json. A resumed or forked session starts from what its history already spent.

Usage of the sessions this one starts counts against the same caps: task children (`tasks`), scouts (`scouts`) and `/btw` (`btw`). A child `pi` gets `OTHALA_BUDGET_REPORT`, a file its own budget extension writes its usage to after each message; the parent reads it when the child exits. `/btw` adds up its side session's messages. Each figure is stored in the session as a `budget-usage` entry, so a resume counts it again. A child also has its own caps, so one task cannot spend more than a session may.

The status line shows `budget 12% · 610k/5M tok`, with the dollar figure when something cost more than 0. `/budget` shows the caps, this session's own usage, each source above, and the total.

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

## Tasks

The `tasks` extension plans before it builds, then runs the plan's tasks in git worktrees, each in a
child `pi`. Planning and review come first; a small change is implemented in the same session.

### Tiers

`~/.pi/agent/tasks.json` names three models as `provider/model` and a concurrency for the task runner.
The `pi` module ships it; Pi never rewrites the file:

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
8000 characters; a failed scout reports its error. The child is the `pi` on PATH, the `pi` module's
wrapper, so it stays offline.

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
`/tasks status [slug]` prints each task's status, and `/tasks stop` stops a run. `/tasks [slug]` opens a view of
the task file, read again each second: each task's status and failed attempts; Enter shows its files, verify
command, granted files and notes; `s`, pressed twice, stops the run when this Pi is running it. They want the TUI or RPC: Pi
does not run extension commands in print mode. A run goes on in the background, with its progress in the status
line, so the session stays usable meanwhile. One run at a time per project: `.pi/worktrees/run.lock` holds the
pid of the Pi running it. The plan file gains an optional `## Finish` section, one line holding the command that runs the
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

   A child that needs a file outside its `files` calls `request_files` with the paths and a reason, and ends.
   The parent grants it when no task that may run at the same time (not done, not ordered with it by `deps`)
   has an overlapping file, adds the paths to the task's `files` and its `granted` list, and starts a child
   again in the same worktree, without a reset, with the answer in its prompt. Otherwise the answer is a refusal
   naming the other task. Nobody is asked. Three requests per task are answered; a fourth ends the attempt.
3. Check. No model reads the diff: the parent checks that nothing is uncommitted, that there is a commit,
   that every file in `git diff --name-only <base> HEAD` matches the task's `files`, and re-runs the verify
   command in the worktree. A failure goes back to a fresh worktree and a new child with the failure as notes.
   Two failures on the task's tier give a third attempt on `large`; after that the task is `failed`, the run
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

Every process a run starts carries `OTHALA_TASK_TREE=<project>#<task>` in its environment, inherited by what
it starts in turn. Stopping kills each process whose `/proc/<pid>/environ` holds that marker, so what a child
started in its own process group or session goes too, and a shell you opened in a worktree does not. The
moments it runs:

| When | What stops |
|---|---|
| `/tasks stop` | the children and everything they started; tasks that already passed their checks still land, nothing new starts |
| Pi quits, or the session is replaced | the same, at `session_shutdown` |
| Pi is killed | each child, at once, by the kernel: children run under `setpriv --pdeathsig KILL` (util-linux). What they started is stopped at the next Pi start in the project, unless another Pi holds the lock |
| `/tasks run` | whatever an earlier run left, before it starts |
| A child passes 30 minutes | that task's processes |

`.pi/plans/` and `.pi/worktrees/` are in the `git` module's global ignore in config, so no project's
`.gitignore` changes.
