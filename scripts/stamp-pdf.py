"""Finish the rendered product flow PDF: the page ground, footers and numbers.

Chrome's --print-to-pdf gives us no control over margin boxes, and CSS @page
margin-box counters are unsupported, so the footer is added afterwards, in
the Seed Plan's form: "Sales Desk · Product flow · <month> · Internal" on
the left and "n / N" on the right. The off-white ground is laid under every
page too, because Chrome leaves the @page margins white.

    python scripts/stamp-pdf.py <file.pdf>

Page 1 is the cover and gets no footer.

build-doc.mjs also calls it to find where each section starts, for the
cover's contents:

    python scripts/stamp-pdf.py --locate <file.pdf> '{"id": "KICKER", ...}'
"""

import json
import os
import re
import sys

import fitz

GROUND = (0xF4 / 255, 0xF4 / 255, 0xF1 / 255)
TEXT_GREY = (0x5D / 255, 0x60 / 255, 0x6B / 255)

MARGIN_X = 42.5          # 15mm in points, the page's side margins
BASELINE_UP = 26.0       # from the page bottom to the footer baseline
FONT_SIZE = 6.8

HERE = os.path.dirname(os.path.abspath(__file__))
SECTIONS = os.path.join(HERE, "..", "doc", "flow-sections.json")

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def month() -> str:
    """The month of the document's date, from the source it was built from."""
    try:
        with open(SECTIONS, encoding="utf-8") as f:
            date = json.load(f).get("date", "")
        return re.sub(r"^\d+\s+", "", date) or "2026"
    except OSError:
        return "2026"


def locate(path: str, kickers: dict) -> None:
    """Print { section id: first page (1-based) holding its kicker }."""
    doc = fitz.open(path)
    texts = [" ".join(page.get_text().split()) for page in doc]
    found = {}
    for sid, kicker in kickers.items():
        want = " ".join(kicker.split())
        for index, text in enumerate(texts):
            if index == 0:          # the cover lists every title
                continue
            if want in text:
                found[sid] = index + 1
                break
    print(json.dumps(found))


def stamp(path: str) -> None:
    doc = fitz.open(path)
    font_file = next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)
    font = fitz.Font(fontfile=font_file) if font_file else fitz.Font("helv")
    left = f"Sales Desk  ·  Product flow  ·  {month()}  ·  Internal"
    total = doc.page_count

    for index, page in enumerate(doc):
        # Chrome leaves its scale on the graphics state at the end of the
        # page, so wrap what it drew before adding anything on top of it.
        page.wrap_contents()
        # The ground goes underneath everything Chrome drew.
        page.draw_rect(page.rect, color=None, fill=GROUND, overlay=False)

        if index == 0:          # cover
            continue

        width, height = page.rect.width, page.rect.height
        y = height - BASELINE_UP
        writer = fitz.TextWriter(page.rect, color=TEXT_GREY)
        writer.append(fitz.Point(MARGIN_X, y), left, font=font, fontsize=FONT_SIZE)
        number = f"{index + 1} / {total}"
        number_width = font.text_length(number, fontsize=FONT_SIZE)
        writer.append(
            fitz.Point(width - MARGIN_X - number_width, y),
            number,
            font=font,
            fontsize=FONT_SIZE,
        )
        writer.write_text(page)

    doc.set_metadata(
        {
            "title": "Sales Desk Product Flow",
            "author": "Sales Desk",
            "subject": "Product flow, tenancy, compliance and build status",
            "keywords": "real estate, RERA, proptech, India",
        }
    )

    doc.saveIncr()
    print(f"stamped {total - 1} pages (cover skipped)")


if __name__ == "__main__":
    if sys.argv[1] == "--locate":
        locate(sys.argv[2], json.loads(sys.argv[3]))
    else:
        stamp(sys.argv[1])
