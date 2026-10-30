/**
 * A PDF of text, rules and shaded boxes, for an invoice.
 *
 * Written here rather than pulled in, the way `zip.ts` was: an invoice needs
 * two of the fourteen standard fonts, which every reader carries, so nothing
 * is embedded, and the file is a catalog, a page tree, the pages and their
 * content streams, with an index of where each object starts. The widths
 * below are the standard Helvetica metrics, needed only to right-align a
 * column of rupees.
 *
 * Text is WinAnsi. A character outside it is written as its nearest ASCII
 * form or a question mark, never dropped silently: a name with a character
 * the font cannot set still shows that something was there.
 */

export const A4 = { w: 595.28, h: 841.89 };

export type Draw =
  | { t: "text"; x: number; y: number; text: string; size: number; bold?: boolean; gray?: number; align?: "left" | "right" | "center" }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; width?: number; gray?: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; gray: number };

// Widths per 1000 units for characters 32 to 126.
// prettier-ignore
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// prettier-ignore
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const NEAREST: Record<string, string> = {
  "₹": "Rs ",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  " ": " ",
};

/** What the font will actually set: printable ASCII only. */
export function winAnsi(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKD")) {
    if (/[̀-ͯ]/.test(ch)) continue;
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) out += ch;
    else if (ch === "\n" || ch === "\t") out += " ";
    else out += NEAREST[ch] ?? "?";
  }
  return out;
}

export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const ch of winAnsi(text)) w += table[ch.charCodeAt(0) - 32] ?? 556;
  return (w * size) / 1000;
}

/** Break text into lines no wider than `max`, at spaces where possible. */
export function wrap(text: string, size: number, max: number, bold = false): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, bold) <= max) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    // A single word longer than the column is cut, not left to run off the page.
    let rest = word;
    while (textWidth(rest, size, bold) > max && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > max) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

const esc = (s: string) => winAnsi(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const n = (v: number) => (Math.round(v * 100) / 100).toString();

function content(draws: readonly Draw[]): string {
  const ops: string[] = [];
  for (const d of draws) {
    if (d.t === "rect") {
      ops.push(`${n(d.gray)} g ${n(d.x)} ${n(d.y)} ${n(d.w)} ${n(d.h)} re f`);
    } else if (d.t === "line") {
      ops.push(`${n(d.width ?? 0.5)} w ${n(d.gray ?? 0)} G ${n(d.x1)} ${n(d.y1)} m ${n(d.x2)} ${n(d.y2)} l S`);
    } else {
      const w = textWidth(d.text, d.size, d.bold);
      const x = d.align === "right" ? d.x - w : d.align === "center" ? d.x - w / 2 : d.x;
      ops.push(`BT /${d.bold ? "F2" : "F1"} ${n(d.size)} Tf ${n(d.gray ?? 0)} g ${n(x)} ${n(d.y)} Td (${esc(d.text)}) Tj ET`);
    }
  }
  return ops.join("\n");
}

/** A PDF of one or more A4 pages. */
export function pdfDocument(pages: readonly (readonly Draw[])[], meta: { title: string; author?: string }): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const tree = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const draws of pages) {
    const stream = content(draws);
    const body = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${body} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(meta.title)}) /Producer (Sales Desk)${meta.author ? ` /Author (${esc(meta.author)})` : ""} >>`);

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
