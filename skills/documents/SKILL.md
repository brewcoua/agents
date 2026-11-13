---
name: documents
description: Read, create, edit or convert PDF, Word (.docx, .odt), Excel (.xlsx, .ods, .csv) and PowerPoint (.pptx, .odp) files. Use whenever a task involves one of these files as input or output, including extracting text or tables, filling a PDF form, merging or splitting PDFs, reading a scanned document, or checking how a generated document looks.
license: MIT
---

# documents

These files are not text. Never `cat` one or edit it with the edit tool: use the tools below, then
check the result by looking at it.

Read the reference for the format at hand, and only that one:

| Format | Reference |
|---|---|
| PDF | [references/pdf.md](references/pdf.md) |
| Word: `.docx`, `.odt`, `.doc` | [references/docx.md](references/docx.md) |
| Spreadsheet: `.xlsx`, `.ods`, `.csv` | [references/xlsx.md](references/xlsx.md) |
| Slides: `.pptx`, `.odp` | [references/pptx.md](references/pptx.md) |

## Rules for every format

1. Never overwrite the input. Write to a new file, and replace the original only when the user asks.
2. Check a tool exists before relying on it (`command -v pdftotext`, `python3 -c 'import openpyxl'`).
   The `documents` module installs them all; if one is missing, say so and name the module.
3. Look at what you produce. Render it to PNG and read the image:
   ```sh
   soffice --headless --convert-to pdf --outdir out/ out/report.docx   # skip for a PDF
   pdftoppm -png -r 80 -f 1 -l 3 out/report.pdf out/page              # out/page-1.png ...
   ```
   Check layout, overflowing text, empty pages and broken tables, not just that the command exited 0.
4. LibreOffice (`soffice`) allows one instance per profile. With a conversion running, or a
   LibreOffice window open, another conversion writes nothing and exits 1 with no message. Run
   conversions one at a time, or give each its own profile and delete it after:
   `soffice -env:UserInstallation=file:///tmp/lo-$$ --headless ...`, then `rm -r /tmp/lo-$$`.
5. Keep generated scripts out of the user's project. Put them in a temporary directory.

## Converting

`soffice --headless --convert-to <ext> --outdir <dir> <file>` converts within one kind of document,
and to `pdf` from any: text (`docx`, `odt`, `doc`, `html`), spreadsheets (`xlsx`, `ods`, `xls`, `csv`),
slides (`pptx`, `odp`, `ppt`). Across kinds, a `.docx` to `.xlsx` say, it writes nothing and exits 1
with no message. Legacy `.doc`, `.xls` and `.ppt` go through it first. `pandoc` converts between
Markdown, HTML and `.docx` and writes `.pptx`; it does not read PDFs.
