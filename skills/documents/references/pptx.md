# Slides

## Read

Convert to PDF, then read it as a PDF (pdf.md): the text comes out in slide order, one page per slide,
and the pages can be rendered to look at.

```sh
soffice --headless --convert-to pdf --outdir out/ in.pptx
pdftotext -layout out/in.pdf -
```

Speaker notes are not in the PDF. They are in `ppt/notesSlides/`, numbered in their own order, not
the slides': a slide without notes has no file. Slide N's `.rels` names its notes file, if any:

```sh
unzip -p in.pptx ppt/slides/_rels/slide3.xml.rels | grep -o 'notesSlide[0-9]*\.xml'
unzip -p in.pptx ppt/notesSlides/notesSlide2.xml | grep -o '<a:t>[^<]*</a:t>'
```

## Create

Write the slides as Markdown, one `#` or `##` heading per slide, then:

```sh
pandoc slides.md -o out.pptx
pandoc slides.md --reference-doc=template.pptx -o out.pptx   # an existing deck's theme
```

Bullets, images, tables, two columns (`:::: columns`) and speaker notes (`::: notes`) come through.
Keep a slide to what fits: render it and check nothing runs off the slide.

## Edit an existing deck

There is no python-pptx here. Edit the XML:

```sh
mkdir deck && cd deck && unzip -q ../in.pptx
# slides are ppt/slides/slideN.xml; text is in <a:t> elements
cd deck && zip -X -r ../out.pptx .
```

Change text inside `<a:t>` only, and keep each element's structure. Adding or removing slides means
editing `ppt/presentation.xml`, `ppt/_rels/presentation.xml.rels` and `[Content_Types].xml` together;
prefer rebuilding the deck with pandoc and the original as `--reference-doc` when the change is large.
Render the result to check it opens and looks right.
