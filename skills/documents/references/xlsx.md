# Spreadsheets

## Read

```python
from itertools import islice
from openpyxl import load_workbook

wb = load_workbook("in.xlsx", data_only=True)   # values as last calculated
for ws in wb.worksheets:
    print(ws.title, ws.dimensions)
    for row in islice(ws.iter_rows(values_only=True), 10):
        print(row)
```

`data_only=True` gives the values Excel or LibreOffice saved with the file. A file written by a
program that never calculated it has `None` there; open it with `data_only=False` to see the formulas.
Look at the dimensions and the first rows before reading a large sheet whole.

`.ods`, `.xls`: `soffice --headless --convert-to xlsx` first. `.csv`: Python's `csv` module; check the
delimiter and the encoding before trusting the columns.

## Write

```python
from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "Summary"
ws.append(["Item", "Amount"])
ws["A1"].font = ws["B1"].font = Font(bold=True)
for item, amount in rows:
    ws.append([item, amount])
ws[f"B{ws.max_row + 1}"] = f"=SUM(B2:B{ws.max_row})"
ws.column_dimensions["A"].width = 30
wb.save("out.xlsx")
```

Prefer formulas to values computed in Python wherever the user may change an input, so the sheet
stays live.

openpyxl writes a formula but never calculates it: until the file is opened in a spreadsheet program,
`data_only` reads `None` for it. To check a formula's result, compute the expected value in Python,
or convert to PDF with `soffice` and read the rendered cell.

## Edit an existing workbook

`load_workbook("in.xlsx")` (formulas kept), change cells, save under a new name. openpyxl drops what
it does not model, such as images, some charts and pivot tables. Open the original with
`load_workbook` and compare: if it had any of those, say they would be lost before replacing anything.
