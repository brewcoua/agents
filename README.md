# agents

Rules, skills and [Pi](https://pi.dev) extensions for coding agents, as one Pi package. Pi loads the
TypeScript as it is; there is no build step.

```text
AGENTS.md      # the working rules
skills/        # grill, handoff, docs-writing, terse-output, simplify, documents
extensions/    # the Pi extensions; extensions/lib/ is shared code
test/          # unit tests (*.test.ts) and the load test (load.ts)
claude/agents/ # Claude Code's subagents: locate, scout, review, research, implement, refactor
docs/          # extensions.md, skills.md
```

[othala config](https://gitlab.com/futharkd/othala/config)'s `pi` module clones this repository to
`~/.local/share/othala/agents`, names the clone in Pi's `packages` setting, and links `AGENTS.md`
where Pi and Claude Code read their rules. `package.json`'s `pi` field lists what Pi loads from it;
config's `claude` module links the skills and `claude/agents/` for Claude Code.

## Checks

Node 22.19 or later, then `npm ci`. CI runs the same three commands on every push:

| Command | Checks |
|---|---|
| `npm run lint` | `tsc --noEmit` against the Pi version pinned in `devDependencies` |
| `npm test` | the unit tests, with coverage thresholds; writes `junit.xml` and `lcov.info` |
| `npm run load` | every extension and skill loads into a real Pi session, offline, in a temporary `HOME` |

The pin is what CI tests. The `pi` module installs the latest Pi, so move the pin when Pi updates.
