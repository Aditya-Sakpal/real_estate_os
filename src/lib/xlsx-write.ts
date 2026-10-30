import { zipStored } from "./zip.ts";

/**
 * One sheet as an .xlsx, written by hand the way `xlsx-read.ts` reads one:
 * five small XML parts in a stored ZIP, no dependency.
 *
 * Every text cell is an inline string, so nothing in it is ever read as a
 * formula, whatever it starts with. The header row is bold and frozen, and a
 * cell given as a link is a real hyperlink, so a recording opens with a click.
 */

export type XlsxCell = string | number | null | { text: string; link: string };

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

/** XML-safe text: escaped, and the control characters XML 1.0 forbids taken out. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `A`, `Z`, `AA`: a column's letters from its 0-based index. */
export function columnName(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const STYLE = { plain: 0, bold: 1, link: 2 } as const;

/** The sheet's XML and its hyperlinks, which live in a part of their own. */
export function sheetXml(header: readonly string[], rows: readonly (readonly XlsxCell[])[], widths: readonly number[] = []): {
  sheet: string;
  links: string[];
} {
  const links: string[] = [];
  const linkRefs: string[] = [];
  const cell = (v: XlsxCell, ref: string, style: number): string => {
    if (v === null || v === "") return "";
    if (typeof v === "number") {
      return Number.isFinite(v) ? `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>` : "";
    }
    if (typeof v === "object") {
      links.push(v.link);
      linkRefs.push(`<hyperlink ref="${ref}" r:id="rId${links.length}"/>`);
      return `<c r="${ref}" s="${STYLE.link}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v.text)}</t></is></c>`;
    }
    return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
  };
  const line = (cells: readonly XlsxCell[], r: number, style: number) =>
    `<row r="${r}">${cells.map((v, i) => cell(v, `${columnName(i)}${r}`, style)).join("")}</row>`;

  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const body = [line(header, 1, STYLE.bold), ...rows.map((r, i) => line(r, i + 2, STYLE.plain))].join("");
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${NS}" xmlns:r="${REL}">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    cols +
    `<sheetData>${body}</sheetData>` +
    (linkRefs.length ? `<hyperlinks>${linkRefs.join("")}</hyperlinks>` : "") +
    `</worksheet>`;
  return { sheet, links };
}

/** The whole workbook: one sheet named `name`. */
export function xlsxFile(
  name: string,
  header: readonly string[],
  rows: readonly (readonly XlsxCell[])[],
  widths: readonly number[] = [],
): Buffer {
  const { sheet, links } = sheetXml(header, rows, widths);
  const sheetName = xmlText(name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
  const enc = (s: string) => new TextEncoder().encode(s);
  const files = [
    {
      name: "[Content_Types].xml",
      bytes: enc(
        `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      bytes: enc(
        `${head}<Relationships xmlns="${PKG}">` +
          `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      bytes: enc(`${head}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      bytes: enc(
        `${head}<Relationships xmlns="${PKG}">` +
          `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "xl/styles.xml",
      bytes: enc(
        `${head}<styleSheet xmlns="${NS}">` +
          `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>` +
          `<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>` +
          `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
          `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
          `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
          `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
          `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
          `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
          `</styleSheet>`,
      ),
    },
    { name: "xl/worksheets/sheet1.xml", bytes: enc(sheet) },
  ];
  if (links.length) {
    files.push({
      name: "xl/worksheets/_rels/sheet1.xml.rels",
      bytes: enc(
        `${head}<Relationships xmlns="${PKG}">` +
          links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/hyperlink" Target="${xmlText(l)}" TargetMode="External"/>`).join("") +
          `</Relationships>`,
      ),
    });
  }
  return zipStored(files);
}
