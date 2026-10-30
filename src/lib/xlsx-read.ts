import { inflateRawSync } from "node:zlib";

/**
 * The first sheet of an .xlsx, as rows of text. Nothing more.
 *
 * A developer's availability sheet arrives as Excel, and asking a sales
 * coordinator to save it as CSV first is asking them to learn a step for
 * us. An .xlsx is a zip of XML, so this reads the zip's directory, inflates
 * the two parts that hold text (the shared strings and the first sheet), and
 * reads the cells. No formulas are evaluated: Excel stores the last value it
 * computed beside each one, and that is what is read. Written by hand for
 * the reason `zip.ts` was: one import did not need a dependency.
 *
 * Bounded: a file over `MAX_XLSX_BYTES`, a part that inflates past
 * `MAX_PART_BYTES`, or more than `MAX_ROWS` rows is refused rather than read.
 */

export const MAX_XLSX_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 40 * 1024 * 1024;
const MAX_ROWS = 5000;

type Entry = { name: string; method: number; compressed: number; offset: number };

function entries(buf: Buffer): Map<string, Entry> {
  // The end-of-central-directory record sits in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad directory");
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    out.set(name, { name, method, compressed, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function part(buf: Buffer, e: Entry | undefined): string | null {
  if (!e) return null;
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("bad entry");
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.compressed);
  if (e.method === 0) return raw.toString("utf8");
  if (e.method !== 8) throw new Error("unsupported compression");
  return inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES }).toString("utf8");
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** Every `<t>` inside one string item, joined: a rich-text cell is several runs. */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join("");

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** The workbook's first sheet, by the workbook's own order rather than by file name. */
function firstSheetPath(files: Map<string, Entry>, buf: Buffer): string {
  const workbook = part(buf, files.get("xl/workbook.xml")) ?? "";
  const rels = part(buf, files.get("xl/_rels/workbook.xml.rels")) ?? "";
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = rid ? new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] : null;
  const alt = rid ? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${rid}"`).exec(rels)?.[1] : null;
  const t = target ?? alt;
  if (!t) return "xl/worksheets/sheet1.xml";
  return t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`;
}

export type XlsxRead = { ok: true; rows: string[][] } | { ok: false; message: string };

export function readXlsx(buf: Buffer): XlsxRead {
  if (buf.length > MAX_XLSX_BYTES) return { ok: false, message: "The file is over 5 MB. Send one tower's sheet at a time." };
  try {
    const files = entries(buf);
    const shared = part(buf, files.get("xl/sharedStrings.xml"));
    const strings = shared ? [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
    const sheet = part(buf, files.get(firstSheetPath(files, buf)));
    if (!sheet) return { ok: false, message: "The workbook has no sheet in it." };
    const rows: string[][] = [];
    for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) return { ok: false, message: `The sheet has more than ${MAX_ROWS} rows.` };
      const row: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let text = "";
        if (type === "s") text = v !== undefined ? strings[Number(v)] ?? "" : "";
        else if (type === "inlineStr") text = textOf(inner);
        else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
        else text = v !== undefined ? unescape(v) : "";
        const at = ref ? columnIndex(ref) : row.length;
        while (row.length < at) row.push("");
        row[at] = text.trim();
      }
      rows.push(row);
    }
    return { ok: true, rows };
  } catch {
    return { ok: false, message: "That file could not be read as an Excel workbook." };
  }
}

/** An .xlsx starts with a zip's local header. */
export const isXlsx = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
