import { inflateRawSync } from "node:zlib";

/**
 * The files inside a zip, read by hand the way `xlsx-read.ts` reads a
 * workbook: the central directory, then each entry stored or deflated. No
 * dependency, and bounded before anything is inflated, so a zip that claims
 * a gigabyte inside it is refused on its directory alone.
 *
 * Folders, macOS's `__MACOSX` copies and hidden files are skipped. A zip
 * that is encrypted, or written in Zip64, is refused with a sentence.
 */

export type ZipEntry = { name: string; bytes: Buffer };
export type Unzipped = { ok: true; entries: ZipEntry[]; skipped: number } | { ok: false; message: string };

type Dir = { name: string; method: number; flags: number; compressed: number; size: number; offset: number };

function directory(buf: Buffer): Dir[] {
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
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64");
  const out: Dir[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad directory");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("zip64");
    // Bit 11 says the name is UTF-8; anything else is near enough read as Latin-1.
    const raw = buf.subarray(at + 46, at + 46 + nameLen);
    out.push({ name: raw.toString(flags & 0x800 ? "utf8" : "latin1"), method, flags, compressed, size, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A name worth opening: a file, not a folder, not the system's own litter. */
export function zipNameKept(name: string): boolean {
  if (!name || name.endsWith("/")) return false;
  const parts = name.split("/");
  if (parts.some((p) => p === "__MACOSX" || p.startsWith("."))) return false;
  const base = parts[parts.length - 1];
  return !/^(thumbs\.db|desktop\.ini)$/i.test(base);
}

/** A PDF or a picture by its name: what a setup reads out of a zip. */
export const zipFileReadable = (name: string): boolean => zipNameKept(name) && /\.(pdf|jpe?g|png|webp)$/i.test(name);

/**
 * What a zip holds, read off its directory alone: nothing is inflated. Enough
 * to refuse a zip with nothing usable in it the moment it lands, and to say
 * how many files it carries.
 */
export function zipListing(buf: Buffer): { ok: true; readable: number } | { ok: false; message: string } {
  let dir: Dir[];
  try {
    dir = directory(buf);
  } catch (e) {
    return { ok: false, message: (e as Error).message === "zip64" ? "is too large a zip to open here. Zip fewer files at a time." : "could not be opened as a zip." };
  }
  const files = dir.filter((d) => zipNameKept(d.name));
  if (files.some((d) => d.flags & 0x1)) return { ok: false, message: "is password protected. Zip it again without a password." };
  return { ok: true, readable: files.filter((d) => zipFileReadable(d.name)).length };
}

export function unzip(buf: Buffer, caps: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }): Unzipped {
  let dir: Dir[];
  try {
    dir = directory(buf);
  } catch (e) {
    const zip64 = (e as Error).message === "zip64";
    return { ok: false, message: zip64 ? "is too large a zip to open here. Zip fewer files at a time." : "could not be opened as a zip." };
  }
  const files = dir.filter((d) => zipNameKept(d.name));
  if (files.some((d) => d.flags & 0x1)) return { ok: false, message: "is password protected. Zip it again without a password." };
  const entries: ZipEntry[] = [];
  let total = 0;
  let skipped = 0;
  for (const d of files) {
    if (entries.length >= caps.maxEntries || d.size > caps.maxEntryBytes || total + d.size > caps.maxTotalBytes || (d.method !== 0 && d.method !== 8)) {
      skipped += 1;
      continue;
    }
    try {
      if (buf.readUInt32LE(d.offset) !== 0x04034b50) throw new Error("bad entry");
      const start = d.offset + 30 + buf.readUInt16LE(d.offset + 26) + buf.readUInt16LE(d.offset + 28);
      const raw = buf.subarray(start, start + d.compressed);
      const bytes = d.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: caps.maxEntryBytes });
      if (bytes.length !== d.size) throw new Error("size");
      total += bytes.length;
      entries.push({ name: d.name, bytes });
    } catch {
      skipped += 1;
    }
  }
  return { ok: true, entries, skipped };
}
