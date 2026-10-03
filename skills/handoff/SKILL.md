---
name: handoff
description: Write a handoff document so the next session, starting with no context, can continue this work. Use when context is running low, when work is pausing for the day, or when the user asks for a handoff or to save session progress.
license: MIT
---

# handoff

Produce one file the next agent can read cold and continue from.

## Steps

1. Check whether `HANDOFF.md` already exists at the project root. If it does, read
   it first — you are updating it, not replacing its history.
2. Gather the current state. Run these rather than recalling them:
   ```bash
   git branch --show-current
   git status --short
   git log --oneline -10
   git diff --stat
   ```
3. Write or update `HANDOFF.md` with exactly these sections:

   - **Goal** — what we are trying to accomplish, in one or two sentences.
   - **Current state** — branch, what is committed, what is uncommitted, whether
     the build and tests pass right now. Say "not run" if you did not run them.
   - **What is done** — one line per change, each with its file path.
   - **What worked** — approaches that succeeded, and why they were chosen.
   - **What did not work** — approaches that failed, and the specific reason. This
     is the most expensive section to rediscover and the most valuable to keep.
   - **Decisions** — each decision made, and the alternative that was rejected.
   - **Open questions** — anything unresolved, including anything you assumed
     without confirming.
   - **Next step** — the single concrete action to take first. Not a list of ideas.

4. Tell the user the file path.

## Rules

ALWAYS write concrete detail: file paths, function names, error strings, commands.
"Fixed the auth issue" is worthless to a cold reader; "`verify()` in
`auth.py:45` compared expiry with `<`, changed to `<=`" is not.
ALWAYS record failed approaches with their reason. Without the reason the next
session repeats them.
ALWAYS state what you did not verify.
NEVER pad it to look thorough. A short accurate handoff beats a long one
containing guesses.
NEVER commit or push as part of this unless the user asks.
