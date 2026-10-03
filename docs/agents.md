# Coding agents

`stow/agents/` configures two coding agents, opencode and Claude Code, from one package. The two
share a rules file and four skills. Each file exists once in the repository.

```
stow/agents/
├── .config/opencode/
│   ├── opencode.json          # provider, models, permissions, the build and plan agents
│   ├── AGENTS.md              # the working rules, for both tools
│   ├── prompts/               # system, orchestrator, plan, build
│   ├── agent/                 # locate, scout, review, research, implement, refactor
│   ├── plugin/                # guardrails, budget, docs-first, tool-descriptions, models-discovery
│   └── skills/docs-lookup/    # opencode only
└── .claude/
    ├── CLAUDE.md -> ../.config/opencode/AGENTS.md
    ├── settings.json
    ├── agents/                # the same six subagents, for Claude Code
    └── skills/                # grill, handoff, docs-writing, terse-output: both tools
```

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
starts with a comment saying so. Change both copies together.

## Claude Code settings

`settings.json` holds the model, plugins, the `rtk` hook and `permissions`. The permissions
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

`stow/zsh/.config/zsh/conf.d/55-opencode.zsh` turns off opencode's background subagents. The
gateway allows three concurrent requests, and background fan-out stacks requests past that limit
until they time out.

Both programs are in `packages/dev.json`: `opencode` from the repositories and `claude-code`
from the AUR.
