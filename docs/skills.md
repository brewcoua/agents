# Rules and skills

`AGENTS.md` is the working rules file, and `skills/` holds six skills: `grill`, `handoff`,
`docs-writing`, `terse-output`, `simplify` and `documents`. Each exists once, here; Pi and Claude
Code read the same files.

## Rules

The rules carry the commit rule: no `Co-Authored-By`, no "Generated with", no mention of Claude, Pi
or AI in a commit message. The guardrails extension enforces it in Pi
([`extensions.md`](extensions.md#guardrails)). The text names the subagents `locate`, `scout`,
`review` and `research`; Claude Code's are in `claude/agents/`, with `implement` and `refactor`.
Pi's arrive with its subagent spawner.

## Documents

The `documents` skill tells an agent which tool to use for a file that is not text. The tools are
large, LibreOffice above all, so they come with othala config's opt-in `documents` module, which
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
