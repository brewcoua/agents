# Word documents

## Read

```sh
pandoc in.docx -t markdown                          # text, headings, lists, tables
pandoc --track-changes=all in.docx -t markdown      # with insertions and deletions marked
pandoc in.docx -t markdown --extract-media=media/   # and the images
```

`.doc` and `.odt`: convert to `.docx` first with `soffice --headless --convert-to docx`.

## Create

Write Markdown, then:

```sh
pandoc in.md -o out.docx
pandoc in.md --reference-doc=template.docx -o out.docx   # styles of an existing document
```

Headings, lists, tables, images, footnotes and links come through. For anything pandoc does not map
(page breaks, columns, headers and footers), build the document with python-docx instead.

## Edit an existing document

Converting to Markdown and back loses the formatting. Edit it in place with python-docx:

```python
from docx import Document

doc = Document("in.docx")
for p in doc.paragraphs:
    for run in p.runs:
        if "2024" in run.text:
            run.text = run.text.replace("2024", "2025")
for table in doc.tables:
    for row in table.rows:
        print([c.text for c in row.cells])
doc.add_paragraph("Added at the end.", style="Normal")
doc.save("out.docx")
```

A paragraph's text is split across runs wherever the formatting changes, sometimes mid-word, so a
phrase may not sit in one run. Check `p.text` to find the paragraph, then edit its runs.

python-docx cannot make tracked changes or comments. When the user asks for those, edit
`word/document.xml` in the unzipped file (`<w:ins>`, `<w:del>`, `<w:comment>` in `word/comments.xml`),
zip it back (`cd dir && zip -X -r ../out.docx .`), and render it to check it still opens.

## Check

Render it (SKILL.md, rule 3) and read the pages.
