"""Wide corpus, producer one: python-docx.

    python3 scripts/fidelity/wide/make_python_docx.py <output folder>

The project's own corpus proves its reader and writer agree with each other.
These are documents made by something else, leaning on Word's built-in styles
and on features set through raw markup, which is how real documents are made:
nothing here is formatted the way this project's writer would format it.

Needs python-docx (pip install python-docx). A development-time tool only; the
product itself has no Python in it.
"""
import io
import struct
import sys
import zlib
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_COLOR_INDEX, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_UNDERLINE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "wide-corpus")
OUT.mkdir(parents=True, exist_ok=True)


def png(width, height, rgb):
    row = b"\x00" + bytes(rgb) * width
    raw = row * height

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return io.BytesIO(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def shade(cell, fill):
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    cell._tc.get_or_add_tcPr().append(shd)


def field(paragraph, instruction, shown):
    for kind in ("begin", None, "separate", "text", "end"):
        run = paragraph.add_run()
        if kind == "text":
            run.text = shown
        elif kind is None:
            instr = OxmlElement("w:instrText")
            instr.set(qn("xml:space"), "preserve")
            instr.text = instruction
            run._r.append(instr)
        else:
            char = OxmlElement("w:fldChar")
            char.set(qn("w:fldCharType"), kind)
            run._r.append(char)


def bookmark(paragraph, name, ident):
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(ident))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(ident))
    paragraph._p.insert(0, start)
    paragraph._p.append(end)


def hyperlink(paragraph, text, url):
    rel = paragraph.part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rel)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    style = OxmlElement("w:rStyle")
    style.set(qn("w:val"), "Hyperlink")
    props.append(style)
    run.append(props)
    t = OxmlElement("w:t")
    t.text = text
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def save(doc, name):
    doc.save(OUT / f"{name}.docx")
    print(name)


LOREM = (
    "The organisation keeps records for as long as they are needed and no longer. Each class of record has an owner, "
    "a period and a trigger, and destruction is recorded. Exceptions need written approval from the record owner. "
)


# 01: every built-in paragraph style, relying on styles alone for its look
def builtin_styles():
    doc = Document()
    doc.add_paragraph("Records Management Policy", style="Title")
    doc.add_paragraph("Group standard, version 4", style="Subtitle")
    for level in range(1, 7):
        doc.add_heading(f"Heading at level {level}", level)
        doc.add_paragraph(LOREM)
    doc.add_paragraph("A quotation in the built-in Quote style.", style="Quote")
    doc.add_paragraph("An intense quotation, boxed and coloured by its style.", style="Intense Quote")
    doc.add_paragraph("Figure 1. A caption in the Caption style.", style="Caption")
    doc.add_paragraph("A paragraph with no spacing, from its style.", style="No Spacing")
    p = doc.add_paragraph()
    for style, text in (("Strong", "strong "), ("Emphasis", "emphasis "), ("Intense Emphasis", "intense emphasis "), ("Subtle Reference", "subtle reference "), ("Book Title", "book title")):
        p.add_run(text, style=style)
    save(doc, "py-01-builtin-styles")


# 02: lists that are lists because of their style, three levels, both kinds
def style_lists():
    doc = Document()
    doc.add_heading("Lists from styles", 1)
    for style, text in (
        ("List Bullet", "First bullet"), ("List Bullet 2", "Second level bullet"), ("List Bullet 3", "Third level bullet"),
        ("List Bullet", "Back to the first level"), ("List Number", "First number"), ("List Number 2", "Second level number"),
        ("List Number 3", "Third level number"), ("List Number", "Second number"), ("List Continue", "A continuation paragraph inside the list"),
        ("List Number", "Third number"),
    ):
        doc.add_paragraph(text, style=style)
    doc.add_paragraph("After the lists.")
    save(doc, "py-02-style-lists")


# 03: character formatting of every kind python-docx can state
def character_formatting():
    doc = Document()
    doc.add_heading("Character formatting", 1)
    p = doc.add_paragraph()
    samples = [
        ("bold ", dict(bold=True)), ("italic ", dict(italic=True)), ("strike ", dict(strike=True)),
        ("double strike ", dict(double_strike=True)), ("all caps ", dict(all_caps=True)), ("small caps ", dict(small_caps=True)),
        ("shadow ", dict(shadow=True)), ("outline ", dict(outline=True)), ("superscript ", dict(superscript=True)),
        ("subscript ", dict(subscript=True)), ("hidden ", dict(hidden=False)),
    ]
    for text, props in samples:
        run = p.add_run(text)
        for key, value in props.items():
            setattr(run.font, key, value)
    p = doc.add_paragraph()
    for kind in (WD_UNDERLINE.SINGLE, WD_UNDERLINE.DOUBLE, WD_UNDERLINE.DOTTED, WD_UNDERLINE.DASH, WD_UNDERLINE.WAVY, WD_UNDERLINE.THICK, WD_UNDERLINE.WORDS):
        run = p.add_run(f"underline {kind} ")
        run.font.underline = kind
    p = doc.add_paragraph()
    for colour in (WD_COLOR_INDEX.YELLOW, WD_COLOR_INDEX.BRIGHT_GREEN, WD_COLOR_INDEX.TURQUOISE, WD_COLOR_INDEX.PINK, WD_COLOR_INDEX.RED, WD_COLOR_INDEX.GRAY_25, WD_COLOR_INDEX.DARK_BLUE):
        run = p.add_run(f"highlight {colour} ")
        run.font.highlight_color = colour
    p = doc.add_paragraph()
    for font, size, rgb in (("Georgia", 9, (0x1F, 0x4E, 0x79)), ("Arial", 14, (0xC0, 0, 0)), ("Courier New", 11, (0x37, 0x56, 0x23)), ("Times New Roman", 22, (0x70, 0x30, 0xA0)), ("Verdana", 7.5, (0, 0, 0))):
        run = p.add_run(f"{font} {size}pt ")
        run.font.name = font
        run.font.size = Pt(size)
        run.font.color.rgb = RGBColor(*rgb)
    save(doc, "py-03-character-formatting")


# 04: paragraph formatting: indents, spacing, line rules, tabs, borders, shading, keep rules
def paragraph_formatting():
    doc = Document()
    doc.add_heading("Paragraph formatting", 1)
    for align in (WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.CENTER, WD_ALIGN_PARAGRAPH.RIGHT, WD_ALIGN_PARAGRAPH.JUSTIFY):
        p = doc.add_paragraph(LOREM)
        p.alignment = align
    p = doc.add_paragraph("Left indent 2 cm, right indent 1 cm, first line 1 cm. " + LOREM)
    p.paragraph_format.left_indent = Cm(2)
    p.paragraph_format.right_indent = Cm(1)
    p.paragraph_format.first_line_indent = Cm(1)
    p = doc.add_paragraph("Hanging indent of 1.5 cm. " + LOREM)
    p.paragraph_format.left_indent = Cm(1.5)
    p.paragraph_format.first_line_indent = Cm(-1.5)
    for rule, value in ((WD_LINE_SPACING.SINGLE, None), (WD_LINE_SPACING.ONE_POINT_FIVE, None), (WD_LINE_SPACING.DOUBLE, None), (WD_LINE_SPACING.EXACTLY, Pt(14)), (WD_LINE_SPACING.AT_LEAST, Pt(18)), (WD_LINE_SPACING.MULTIPLE, 1.15)):
        p = doc.add_paragraph(f"Line spacing {rule}. " + LOREM)
        p.paragraph_format.line_spacing_rule = rule
        if value is not None:
            p.paragraph_format.line_spacing = value
    p = doc.add_paragraph("Twelve points before and eighteen after.")
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(18)
    p = doc.add_paragraph("Name\tAmount\tDate")
    tabs = p.paragraph_format.tab_stops
    tabs.add_tab_stop(Cm(6), WD_TAB_ALIGNMENT.RIGHT)
    tabs.add_tab_stop(Cm(12), WD_TAB_ALIGNMENT.CENTER)
    p = doc.add_paragraph("Boxed and shaded paragraph.")
    ppr = p._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    for side in ("top", "left", "bottom", "right"):
        edge = OxmlElement(f"w:{side}")
        edge.set(qn("w:val"), "single")
        edge.set(qn("w:sz"), "8")
        edge.set(qn("w:space"), "4")
        edge.set(qn("w:color"), "1F4E79")
        borders.append(edge)
    ppr.append(borders)
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), "DEEAF6")
    ppr.append(shd)
    p = doc.add_paragraph("Kept with the next paragraph, and its lines kept together.")
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.keep_together = True
    p = doc.add_paragraph("Starts a new page.")
    p.paragraph_format.page_break_before = True
    save(doc, "py-04-paragraph-formatting")


# 05: tables in built-in table styles, with merges both ways, alignment and widths
def tables():
    doc = Document()
    doc.add_heading("Tables", 1)
    for style in ("Table Grid", "Light Shading Accent 1", "Light List Accent 2", "Medium Shading 1 Accent 1", "Light Grid Accent 3"):
        doc.add_paragraph(f"Style: {style}")
        table = doc.add_table(rows=4, cols=4, style=style)
        for c, head in enumerate(("Class", "Owner", "Period", "Trigger")):
            table.cell(0, c).text = head
        for r in range(1, 4):
            for c in range(4):
                table.cell(r, c).text = f"r{r}c{c}"
    doc.add_paragraph("Merged both ways, fixed widths, centred on the page")
    table = doc.add_table(rows=5, cols=5, style="Table Grid")
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for row in table.rows:
        for index, cell in enumerate(row.cells):
            cell.width = Cm(1.5 + index)
    table.cell(0, 0).merge(table.cell(0, 4)).text = "Across all five"
    table.cell(1, 0).merge(table.cell(3, 0)).text = "Down three"
    table.cell(1, 1).merge(table.cell(2, 2)).text = "A block of four"
    for r in range(1, 5):
        for c in range(1, 5):
            if not table.cell(r, c).text:
                table.cell(r, c).text = f"{r},{c}"
    shade(table.cell(4, 4), "FFC000")
    doc.add_paragraph("A table inside a table")
    outer = doc.add_table(rows=1, cols=2, style="Table Grid")
    outer.cell(0, 0).text = "Left cell"
    inner = outer.cell(0, 1).add_table(rows=2, cols=2)
    inner.style = "Table Grid"
    for r in range(2):
        for c in range(2):
            inner.cell(r, c).text = f"inner {r}{c}"
    save(doc, "py-05-tables")


# 06: sections, orientation, margins, columns, headers with fields and a picture, different first page
def sections_and_headers():
    doc = Document()
    first = doc.sections[0]
    first.different_first_page_header_footer = True
    first.first_page_header.paragraphs[0].text = "FIRST PAGE HEADER ONLY"
    header = first.header.paragraphs[0]
    header.add_run().add_picture(png(120, 30, (31, 78, 121)), width=Cm(3))
    header.add_run("   Records Management Policy")
    footer = first.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.add_run("Page ")
    field(footer, "PAGE", "1")
    footer.add_run(" of ")
    field(footer, "NUMPAGES", "3")
    first.left_margin = Cm(3)
    first.right_margin = Cm(2)
    doc.add_heading("Section one, portrait", 1)
    for _ in range(6):
        doc.add_paragraph(LOREM * 2)
    wide = doc.add_section(WD_SECTION.NEW_PAGE)
    wide.orientation = WD_ORIENT.LANDSCAPE
    wide.page_width, wide.page_height = wide.page_height, wide.page_width
    doc.add_heading("Section two, landscape", 1)
    table = doc.add_table(rows=3, cols=9, style="Table Grid")
    for r in range(3):
        for c in range(9):
            table.cell(r, c).text = f"{r * 9 + c}"
    cols = doc.add_section(WD_SECTION.CONTINUOUS)
    cols.orientation = WD_ORIENT.PORTRAIT
    cols.page_width, cols.page_height = cols.page_height, cols.page_width
    columns = cols._sectPr.xpath("./w:cols")
    element = columns[0] if columns else OxmlElement("w:cols")
    element.set(qn("w:num"), "2")
    element.set(qn("w:space"), "708")
    if not columns:
        cols._sectPr.append(element)
    doc.add_heading("Section three, two columns", 1)
    for _ in range(5):
        doc.add_paragraph(LOREM * 2)
    save(doc, "py-06-sections-headers")


# 07: fields, bookmarks, cross-references, links, a contents field
def references():
    doc = Document()
    doc.add_heading("References", 1)
    toc = doc.add_paragraph()
    field(toc, 'TOC \\o "1-3" \\h \\z \\u', "Update this field to build the contents.")
    head = doc.add_heading("Scope", 2)
    bookmark(head, "scope", 1)
    p = doc.add_paragraph("As set out in ")
    field(p, "REF scope \\h", "Scope")
    p.add_run(", printed on ")
    field(p, 'DATE \\@ "d MMMM yyyy"', "18 September 2026")
    p.add_run(" by ")
    field(p, "AUTHOR", "A. Writer")
    p.add_run(". File: ")
    field(p, "FILENAME", "policy.docx")
    p.add_run(". END-OF-FIELDS.")
    p = doc.add_paragraph("See ")
    hyperlink(p, "the external standard", "https://standards.example.invalid/records")
    p.add_run(" and write to ")
    hyperlink(p, "the records team", "mailto:records@example.invalid")
    p.add_run(".")
    cap = doc.add_paragraph("Table ", style="Caption")
    field(cap, "SEQ Table \\* ARABIC", "1")
    cap.add_run(". Retention periods")
    save(doc, "py-07-references")


# 08: comments, replies are beyond python-docx, single comments are not
def comments():
    doc = Document()
    doc.add_heading("Commented draft", 1)
    p = doc.add_paragraph("Financial records are kept for ")
    target = p.add_run("seven years")
    p.add_run(" from the end of the financial year.")
    doc.add_comment(runs=target, text="Should this be ten, to match the tax rule?", author="Legal Reviewer", initials="LR")
    p2 = doc.add_paragraph("Personnel records are kept for six years after leaving.")
    doc.add_comment(runs=p2.runs[0], text="Check against the employment standard.\nSecond line of the same comment.", author="People Team", initials="PT")
    save(doc, "py-08-comments")


# 09: pictures of several kinds and sizes, one per paragraph and several in a line
def pictures():
    doc = Document()
    doc.add_heading("Pictures", 1)
    doc.add_picture(png(600, 200, (31, 78, 121)), width=Cm(16))
    p = doc.add_paragraph("Three in a line: ")
    for rgb in ((192, 0, 0), (0, 112, 192), (0, 176, 80)):
        p.add_run().add_picture(png(60, 60, rgb), width=Cm(1.5))
    p.add_run(" and text after them.")
    centred = doc.add_paragraph()
    centred.alignment = WD_ALIGN_PARAGRAPH.CENTER
    centred.add_run().add_picture(png(200, 120, (112, 48, 160)), width=Cm(6))
    table = doc.add_table(rows=1, cols=2, style="Table Grid")
    table.cell(0, 0).paragraphs[0].add_run().add_picture(png(100, 100, (255, 192, 0)), width=Cm(3))
    table.cell(0, 1).text = "A picture in a table cell"
    save(doc, "py-09-pictures")


# 10: languages and characters that break naive text handling
def scripts_and_symbols():
    doc = Document()
    doc.add_heading("Scripts and symbols", 1)
    for text in (
        "Arabic: يجب على جميع الموظفين إكمال الإقرار السنوي.",
        "Hebrew: כל העובדים חייבים להשלים את ההצהרה השנתית.",
        "Chinese: 所有员工必须完成年度声明。",
        "Japanese: 全従業員は年次証明を完了する必要があります。",
        "Korean: 모든 직원은 연례 확인을 완료해야 합니다.",
        "Hindi: सभी कर्मचारियों को वार्षिक सत्यापन पूरा करना होगा।",
        "Thai: พนักงานทุกคนต้องกรอกคำรับรองประจำปี",
        "Greek and Cyrillic: Όλοι οι εργαζόμενοι · Все сотрудники",
        "Symbols: € £ ¥ ¢ § ¶ † ‡ • … ‰ ′ ″ ← → ↔ ≤ ≥ ≠ ± × ÷ √ ∞ µ Ω ™ © ®",
        "Emoji: 🔒 📄 ✅ ❌ 👩‍💼 🇪🇺",
        "Markup-like: <script>alert('x')</script> & \"quotes\" <b>not bold</b> ]]> <!-- c -->",
        "Whitespace:  two  spaces,\ttab, non breaking, zero​width, soft­hyphen, non‑breaking hyphen.",
    ):
        doc.add_paragraph(text)
    save(doc, "py-10-scripts-symbols")


# 11: a long document, to see that size alone breaks nothing
def long_document():
    doc = Document()
    doc.add_paragraph("Operations Manual", style="Title")
    for chapter in range(1, 41):
        doc.add_heading(f"Chapter {chapter}", 1)
        for section in range(1, 4):
            doc.add_heading(f"Section {chapter}.{section}", 2)
            for _ in range(4):
                doc.add_paragraph(LOREM * 3)
            table = doc.add_table(rows=4, cols=3, style="Table Grid")
            for r in range(4):
                for c in range(3):
                    table.cell(r, c).text = f"{chapter}.{section}.{r}.{c}"
    save(doc, "py-11-long-document")


# 12: the awkward edges: empty document, only a table, only a picture, empty cells and paragraphs
def edges():
    save(Document(), "py-12a-empty")
    doc = Document()
    table = doc.add_table(rows=2, cols=2, style="Table Grid")
    table.cell(0, 0).text = "Only a table"
    save(doc, "py-12b-only-table")
    doc = Document()
    doc.add_picture(png(300, 100, (0, 112, 192)), width=Cm(8))
    save(doc, "py-12c-only-picture")
    doc = Document()
    for _ in range(5):
        doc.add_paragraph("")
    doc.add_paragraph("Text after five empty paragraphs.")
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    doc.add_paragraph("Text after two page breaks.")
    p = doc.add_paragraph("Line one")
    p.add_run().add_break(WD_BREAK.LINE)
    p.add_run("Line two after a soft return")
    p.add_run().add_break(WD_BREAK.COLUMN)
    p.add_run("After a column break")
    save(doc, "py-12d-empty-paragraphs-breaks")


# 13: a wide register: many rows, banded, with a repeated header row
def big_table():
    doc = Document()
    doc.add_heading("Risk register", 1)
    rows = 600
    table = doc.add_table(rows=rows + 1, cols=6, style="Table Grid")
    for c, head in enumerate(("Ref", "Risk", "Owner", "Inherent", "Residual", "Due")):
        cell = table.cell(0, c)
        cell.text = head
        shade(cell, "1F3864")
    header = OxmlElement("w:tblHeader")
    table.rows[0]._tr.get_or_add_trPr().append(header)
    fills = ["C6E0B4", "FFE699", "F4B084", "FF7C80"]
    for r in range(1, rows + 1):
        for c, text in enumerate((f"R-{r:04d}", f"Control weakness in process area {r % 17}", f"Owner {r % 11}", "High", ("Low", "Medium", "High", "Critical")[r % 4], f"2026-{r % 12 + 1:02d}-15")):
            table.cell(r, c).text = text
        shade(table.cell(r, 4), fills[r % 4])
    save(doc, "py-13-big-table")


for build in (builtin_styles, style_lists, character_formatting, paragraph_formatting, tables, sections_and_headers, references, comments, pictures, scripts_and_symbols, long_document, edges, big_table):
    build()
