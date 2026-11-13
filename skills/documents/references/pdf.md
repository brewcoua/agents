# PDF

## Read

```sh
pdfinfo in.pdf                          # pages, size, encrypted, producer
pdftotext -layout in.pdf -              # all text, columns kept in place
pdftotext -layout -f 3 -l 5 in.pdf -    # pages 3 to 5
pdftoppm -png -r 100 -f 2 -l 2 in.pdf p # page 2 as p-2.png (or p-02.png), to look at
pdfimages -list in.pdf                  # embedded images
```

Tables: `pdftotext -layout` keeps columns aligned, which is usually enough to read them. Render the
page and look at it when the alignment is ambiguous.

No text out of `pdftotext` means a scanned PDF. OCR it page by page:

```sh
pdftoppm -png -r 300 in.pdf scan
for p in scan-*.png; do tesseract "$p" - 2>/dev/null; done
```

Tesseract reads English with the installed data. Say so when the document is in another language.

## Pages: merge, split, rotate, decrypt

```sh
qpdf --empty --pages a.pdf b.pdf -- out.pdf           # merge
qpdf in.pdf --pages . 1-3 -- out.pdf                  # pages 1 to 3
qpdf in.pdf --pages . 1,4,z -- out.pdf                # 1, 4 and the last
qpdf in.pdf out.pdf --rotate=+90:2                    # rotate page 2
qpdf --password='...' --decrypt in.pdf out.pdf        # needs the password
qpdf --check in.pdf                                   # structural errors
```

## Forms

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("form.pdf")
for name, field in (reader.get_fields() or {}).items():
    print(name, field.get("/FT"), field.get("/V"), field.get("/_States_", ""))

writer = PdfWriter(clone_from=reader)
writer.update_page_form_field_values(None, {"Name": "Ada", "Agree": "/Yes"}, auto_regenerate=False)  # None: every page
writer.set_need_appearances_writer(True)
writer.write("filled.pdf")
```

A checkbox takes one of the states `/_States_` lists, not `True`. No fields means the form is
flat: say so; writing text onto a flat PDF is a different, fragile job. Render the filled pages
and check every value shows.

## Create

There is no LaTeX here, so `pandoc -o out.pdf` fails. Write the content as `.docx` (see docx.md) or
HTML, then convert:

```sh
soffice --headless --convert-to pdf --outdir out/ out/report.docx
```
