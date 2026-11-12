---
name: simplify
description: Review a diff for code that need not exist and propose cuts. Use when asked to simplify, trim, or de-bloat a change, when reviewing a diff before commit or PR, or when a change feels bigger than the request.
license: MIT
---

# simplify

Review a change for what to cut. Quality lever only: do not hunt for bugs, and
do not change behavior. The standard is AGENTS.md sections 3 and 4 (simplicity
first, surgical changes) and the code rules of the `terse-output` skill.

## Procedure

1. Get the diff: the one you were given, else `git diff HEAD`. Read each
   changed file around the hunks, and grep for callers before judging reuse.
2. Walk the diff against the list below. Judge only added or changed lines;
   mention unrelated dead code, never cut it.
3. Output one line per finding, then stop. Apply a cut only if asked.

## What to find

| Finding | Test |
|---|---|
| Speculative generality | A parameter, option, hook, or branch no caller uses or the request named |
| Single-caller abstraction | A function, class, or layer with one caller that adds no clarity |
| Hand-rolled stdlib | Code the standard library, a language native, or an installed dependency already does |
| Dead code | Unused imports, variables, functions, or branches, including ones this change orphaned |
| Leftovers | `_unused` renames, "removed" comments, wrapper shims, commented-out code |
| Restating comments | A comment that says what the code says; if it explains confusing code, simplify the code |
| Error handling for the impossible | A guard for a case no caller can produce |
| Untraced lines | A changed line that does not follow from the request: reformatting, renames, drive-by refactors |

## Never propose cutting

- Validation at trust boundaries, error handling that prevents data loss,
  security checks, accessibility basics.
- Anything the request asked for.
- A comment that records intent, a constraint, a tradeoff, or a workaround.

## Output

```
path:line  <finding>  -> <cut or replacement>  (-N lines)
```

End with the total lines saved. If the change is already minimal, say so in one line.
