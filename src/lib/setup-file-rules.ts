/**
 * What can be said about an attached file before a byte of it is sent:
 * its type, its size, its name as shown. Pure and client-safe, so the
 * composer refuses a HEIC photo or a 90 MB PDF at once, and the server asks
 * exactly the same again. `setup-rules.ts` re-exports all of it.
 */

/** Files one setup may be read from, a zip's counted one by one. */
export const SETUP_MAX_FILES = 60;
/** A PDF's size, and a picture's. A brochure runs to tens of megabytes. */
export const SETUP_PDF_BYTES = 60 * 1024 * 1024;
export const SETUP_IMAGE_BYTES = 25 * 1024 * 1024;
/** A zip of pictures and brochures, opened on our side into the files inside it. */
export const SETUP_ZIP_BYTES = 120 * 1024 * 1024;
/** Files taken out of one zip; the rest are named as left out. */
export const SETUP_ZIP_MAX_ENTRIES = 40;

export const SETUP_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type SetupFileType = (typeof SETUP_FILE_TYPES)[number];
export const ZIP_TYPE = "application/zip";
/** What may be attached: a file a setup reads, or a zip of them. */
export const ATTACH_TYPES = [...SETUP_FILE_TYPES, ZIP_TYPE] as const;
export type AttachType = SetupFileType | typeof ZIP_TYPE;

// ---------------------------------------------------------------------------
// A file, before a byte is sent
// ---------------------------------------------------------------------------

export type FileCheck = { ok: true; type: AttachType; size: number; sha256: string; name: string } | { ok: false; message: string };

/** A file's name as it will be shown: no path, no formula start, capped. */
export function fileName(raw: unknown): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const text = base.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^[=+\-@]+/, "");
  return text.slice(0, 200) || "File";
}

/** Everything that can be refused about a file before it is uploaded. */
export function fileProblem(input: { name: unknown; type: unknown; size: unknown; sha256: unknown }): FileCheck {
  const name = fileName(input.name);
  let type = String(input.type ?? "").toLowerCase();
  // Windows calls a zip "x-zip-compressed", some browsers give nothing for it.
  if (/\.zip$/i.test(name) && (!type || /zip/.test(type) || type === "application/octet-stream")) type = ZIP_TYPE;
  if (/\.(heic|heif)$/i.test(name) || type === "image/heic" || type === "image/heif") {
    return { ok: false, message: `${name} is a HEIC photo. Save it as a JPEG and attach it again.` };
  }
  if (/\.svg$/i.test(name) || type === "image/svg+xml") return { ok: false, message: `${name}: attach the picture as a JPEG or PNG.` };
  if (!(ATTACH_TYPES as readonly string[]).includes(type)) {
    return { ok: false, message: `${name}: attach a PDF, a picture (JPEG, PNG or WebP) or a zip of them.` };
  }
  const size = Number(input.size);
  const cap = type === ZIP_TYPE ? SETUP_ZIP_BYTES : type === "application/pdf" ? SETUP_PDF_BYTES : SETUP_IMAGE_BYTES;
  if (!Number.isFinite(size) || size <= 0) return { ok: false, message: `${name} is empty.` };
  if (size > cap) return { ok: false, message: `${name} is over ${Math.round(cap / 1024 / 1024)} MB. Attach a smaller copy.` };
  const sha256 = String(input.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, message: `${name} could not be read. Attach it again.` };
  return { ok: true, type: type as AttachType, size, sha256, name };
}
