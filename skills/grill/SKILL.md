---
name: grill
description: Interrogate a plan, design, or decision until every branch is settled and nothing is silently assumed. Use when the user wants their thinking stress-tested, when a request is large enough that guessing wrong would be expensive, or when they ask to be grilled or challenged before implementation starts.
license: MIT
---

# grill

Interview the user until you reach a shared understanding. Map the work as a
design tree: every decision branches into the decisions that hang off it.

Work in rounds. The **frontier** is every decision whose prerequisites are already
settled — the questions you can ask now without guessing at answers you have not
heard yet. Ask the whole frontier in one round. Then wait.

## Round format

```
Q1. <short title>
<the question, including the concrete options where there are options>
Recommend: <your answer, and the one-line reason>

Q2. <short title>
<question>
Recommend: <your answer, and the one-line reason>
```

ALWAYS number the questions.
ALWAYS give your recommended answer with each one. A question without a
recommendation makes the user do your thinking.
ALWAYS stop after the round and wait for answers.

## Between rounds

Each set of answers reshapes the tree. Settled decisions push the frontier
outward and unblock questions that depended on them. Recompute the frontier and
ask the next round.

A question whose answer depends on another question still open in this round
belongs to a later round, not this one.

## Facts are your job, decisions are theirs

NEVER ask the user for something you could look up. File contents, existing
conventions, installed versions, what a function currently does — find these
yourself with `locate`, `scout`, or a read.

Do not block on a lookup. A running search is an unsettled prerequisite, so only
the questions downstream of it wait. Ask the rest of the frontier now.

Put every genuine decision to the user and wait. Do not decide it for them because
your recommendation seems obvious.

## Done

The session ends when the frontier is empty: every branch visited, nothing
silently assumed.

Then summarize the settled design in under 150 words and ask for confirmation.
NEVER start implementing until the user confirms.
