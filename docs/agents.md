# Coding agents

Three modules under `modules/tools/` configure two coding agents. `agents-common` holds what the
agents share, a rules file and six skills; Pi ([`25-pi.md`](25-pi.md)) uses them too. `opencode`
holds opencode's configuration. `claude` installs Claude Code and holds its settings and subagents.
Both tool modules require `agents-common`. Each shared file exists once in the repository.

```
modules/tools/agents-common/home/
├── .config/
│   ├── agents/AGENTS.md       # the working rules, for both tools
│   └── opencode/AGENTS.md -> ../agents/AGENTS.md
└── .claude/
    ├── CLAUDE.md -> ../.config/agents/AGENTS.md
    └── skills/                # grill, handoff, docs-writing, terse-output, simplify, documents

modules/tools/opencode/home/.config/opencode/
├── opencode.json              # provider, permissions, the build and plan agents
├── prompts/                   # system, orchestrator, plan, build
├── agent/                     # locate, scout, review, research, implement, refactor
├── plugin/                    # guardrails, budget, docs-first, tool-descriptions, models-discovery
└── skills/docs-lookup/        # opencode only

modules/tools/claude/home/.claude/
├── settings.json
└── agents/                    # the same six subagents, for Claude Code
```

Claude Code is not a package. The `claude` module's `release` recipe downloads Anthropic's own
build, on Arch and Fedora alike, and checks its sha256 against a manifest that Anthropic signs; the
module pins the signing key's fingerprint, and gpg verifies in a temporary keyring, so yours is
never touched. The binary lands in `~/.local/share/claude/versions/<version>` and `~/.local/bin/claude`
points at it. Nothing is pinned to a version: `othala update` installs the latest and removes the
previous one. `othala module show claude` prints the method and the fingerprint.

## Sharing without copies

**Skills.** opencode reads `~/.claude/skills/<name>/SKILL.md` as well as its own
`~/.config/opencode/skills/`, so a skill under `.claude/skills/` reaches both tools with no
link of its own. Put a skill there to share it, or under `.config/opencode/skills/` to keep it
opencode's alone. A name must not exist in both places. opencode does not say which copy wins.

**Documents.** The `documents` skill tells an agent which tool to use for a file that is not text.
The tools are large, LibreOffice above all, so they come with the opt-in `documents` module, which
installs packages and links nothing; without it the skill says which module is missing.

| Format | Tools |
|---|---|
| PDF | `pdftotext`, `pdftoppm`, `pdfinfo` (poppler), `qpdf`, pypdf, `tesseract` for scans |
| Word | `pandoc`, python-docx |
| Spreadsheets | openpyxl |
| Slides | `pandoc` to write them, the raw XML to edit them |
| All | LibreOffice (`soffice --headless`) to convert, and to render a file to check how it looks |

`SKILL.md` is a short router; the commands for each format sit in `references/<format>.md`, which
an agent reads only for the format at hand. python-pptx and pdfplumber are not in Arch's official
repositories, and Fedora does not package python-docx either, so the skill does without them and
falls back to the raw XML.

**Rules.** The rules file is `~/.config/agents/AGENTS.md`. `~/.config/opencode/AGENTS.md` and
`~/.claude/CLAUDE.md` are symlinks committed to git, pointing at it. `othala link` links a symlink
inside a package the way it links a file, so both resolve through the repository to the one rules
file. The file also carries the commit rule: no `Co-Authored-By`, no "Generated with", no mention of
Claude, Pi or AI in a commit message. The text names the subagents `locate`, `scout`,
`review` and `research`, and both tools have all four.

**Subagents are the exception.** The two tools disagree on frontmatter (models, permissions,
tool lists), and a Claude Code subagent cannot start another subagent. So `.claude/agents/` holds
copies of the bodies, edited only where an opencode agent delegates: `research` searches
itself instead of dispatching scouts, and `implement` drops the orchestrator prompt. Each copy
starts with a comment saying so. Change both copies together; they now sit in different modules,
opencode's in `opencode` and Claude Code's in `claude`.

## Claude Code settings

`settings.json` (in the `claude` module) holds the model, `env` and `permissions`. `env`
sets `DISABLE_AUTOUPDATER` to `1`: `othala update` is what updates Claude Code, through the same
signed-release recipe, and Claude Code's own updater would replace the binary without that check. The permissions
translate `opencode.json`'s bash rules: read-only commands and git queries are allowed, history
rewrites and pushes ask, and `rm -rf`, `sudo`, `git reset --hard` and the like are denied. Files
that `guardrails.js` treats as secrets (`.env`, keys, certificates, SSH identities) are denied
to `Read`. Two rules have no equivalent:

- opencode denies piping into an interpreter (`curl … | sh`). Claude Code permission rules match
  command prefixes, so nothing here catches a pipe in the middle of a command.
- The `Read` deny does not stop `cat .env` through `Bash`. That needs a hook, which is what
  `guardrails.js` is on the opencode side.

Claude Code installs no plugin or marketplace, and `attribution` is empty for commits and pull
requests. It writes `settings.json` itself, for example from `/config`. Those writes go through the link into the repository and show up in `git diff`.
Commit them or revert them.

## Providers

`opencode.json` still defines the `futhark` provider, but lists it in `disabled_providers` and sets
no `model` or `small_model`, so no agent defaults to the gateway. The subagents and the `build` and
`plan` agents name no model either; opencode picks the one selected in the session.

## Environment

`modules/tools/zsh/home/.config/zsh/conf.d/55-opencode.zsh` turns off opencode's background subagents. The
gateway allows three concurrent requests, and background fan-out stacks requests past that limit
until they time out.

opencode is in the `opencode` module's `install` recipes: from the Arch repositories, and on Fedora
from npm (`opencode-ai`, with `nodejs-npm` from dnf). Claude Code is the `claude` module's `release` recipe, not the AUR's `claude-code`. A machine that still
has that package installed keeps it, since `othala sync` never removes anything.
