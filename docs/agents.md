# Coding agents

Two modules under `modules/tools/` configure two coding agents. `agents` holds opencode's
configuration and what the two tools share, a rules file and four skills. `claude` installs Claude
Code and holds its settings and subagents; it requires `agents`. Each shared file exists once in the
repository.

```
modules/tools/agents/home/
├── .config/opencode/
│   ├── opencode.json          # provider, models, permissions, the build and plan agents
│   ├── AGENTS.md              # the working rules, for both tools
│   ├── prompts/               # system, orchestrator, plan, build
│   ├── agent/                 # locate, scout, review, research, implement, refactor
│   ├── plugin/                # guardrails, budget, docs-first, tool-descriptions, models-discovery
│   └── skills/docs-lookup/    # opencode only
└── .claude/
    ├── CLAUDE.md -> ../.config/opencode/AGENTS.md
    └── skills/                # grill, handoff, docs-writing, terse-output: both tools

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

**Rules.** `CLAUDE.md` is a symlink committed to git, pointing at `AGENTS.md`. `othala link`
links a symlink inside a package the way it links a file, so `~/.claude/CLAUDE.md` resolves
through the repository to the one rules file. The text names the subagents `locate`, `scout`,
`review` and `research`, and both tools have all four.

**Subagents are the exception.** The two tools disagree on frontmatter (models, permissions,
tool lists), and a Claude Code subagent cannot start another subagent. So `.claude/agents/` holds
copies of the bodies, edited only where an opencode agent delegates: `research` searches
itself instead of dispatching scouts, and `implement` drops the orchestrator prompt. Each copy
starts with a comment saying so. Change both copies together; they now sit in different modules,
opencode's in `agents` and Claude Code's in `claude`.

## Claude Code settings

`settings.json` (in the `claude` module) holds the model, plugins, `env` and `permissions`. `env`
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

Claude Code writes `settings.json` itself, for example from `/config` or when a plugin is
installed. Those writes go through the link into the repository and show up in `git diff`.
Commit them or revert them.

## Environment

`modules/tools/zsh/home/.config/zsh/conf.d/55-opencode.zsh` turns off opencode's background subagents. The
gateway allows three concurrent requests, and background fan-out stacks requests past that limit
until they time out.

opencode is in the `agents` module's `install` recipes: from the Arch repositories, and on Fedora
from npm (`opencode-ai`, with `nodejs-npm` from dnf). Claude Code is the `claude` module's `release` recipe, not the AUR's `claude-code`. A machine that still
has that package installed keeps it, since `othala sync` never removes anything.
