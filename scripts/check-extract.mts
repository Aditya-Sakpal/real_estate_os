/**
 * The Brain's document readers, end to end, with the model answering from
 * `MODELS_DIR` fixtures and the store in memory.
 *
 *   node --experimental-strip-types --env-file=.env.local scripts/check-extract.mts
 *
 * The suite builds a tenant of its own (a project, two towers, one with a
 * registration on file and a published Brain), makes real PDFs and a picture
 * of one, uploads them through the real functions, reads them with the real
 * pdf.js and Tesseract, and answers the model's part from files named by the
 * hash of each request, the seam production never sets. One test injects a
 * driver instead, to spend past the budget without paying anybody.
 */
import postgres from "postgres";
import sharp from "sharp";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../src/lib/db/index.ts";
import { useStorage, sha256, type StorageDriver } from "../src/lib/storage.ts";
import { pdfDocument, type Draw } from "../src/lib/pdf.ts";
import { readPages, renderPreview, useVisionReader } from "../src/lib/pdf-read.ts";
import { stopOcr } from "../src/lib/ocr.ts";
import { brainNode, saveGroup, signGroup, publishBrain } from "../src/lib/brain.ts";
import { addUnitType } from "../src/lib/unit.ts";
import {
  chunkPages,
  docKindDef,
  EXTRACTORS,
  extractRequest,
  fieldsToRead,
  type DocKind,
  type PageText,
} from "../src/lib/extract-rules.ts";
import {
  beginUpload,
  decideProposal,
  documentSummary,
  extractRequestId,
  finishUpload,
  loadDocuments,
  pagePreview,
  documentFile,
  queueExtraction,
  readUploadToken,
  removeDocument,
  runExtraction,
  useExtractDriver,
} from "../src/lib/extract.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// A store in memory, and a folder of canned answers
// ---------------------------------------------------------------------------

const store = new Map<string, Buffer>();
const memory: StorageDriver = {
  name: "memory",
  async put(key, bytes) {
    store.set(key, Buffer.from(bytes));
  },
  async signedUrl(key) {
    return `memory://${key}`;
  },
  async remove(key) {
    store.delete(key);
  },
  async copy(from, to) {
    const b = store.get(from);
    if (b) store.set(to, Buffer.from(b));
  },
  async read(key) {
    const b = store.get(key);
    return b ? Buffer.from(b) : null;
  },
};
useStorage(memory);
const fixtures = await mkdtemp(join(tmpdir(), "extract-"));
process.env.MODELS_DIR = fixtures;
// Pages with no text layer are read by Tesseract here, the fall-back when the
// vision model cannot read one; the vision path is proven on its own below.
useVisionReader(null);

// ---------------------------------------------------------------------------
// A tenant of its own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const [admin] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@extract${tag}.example`}, ${`extract${tag}.example`}, 'Extract Admin') RETURNING id`;
const [org] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Sath Group', 'Sath Group', 'AAPFU0939F', ${`extract${tag}.example`}, ${admin.id}) RETURNING id`;
const orgId = org.id;
const [root] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${orgId}, NULL, 'ORG', 'Sath Group', ${`extract_${tag}`}, ${`extract_${tag}`}::ltree) RETURNING id, path::text AS path`;
const node = async (parent: { id: string; path: string }, kind: string, name: string, slug: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${parent.id}, ${kind}, ${name}, ${slug}, ${`${parent.path}.${slug}`}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(root, "ENTITY", "Sath Heights LLP", "sath_llp");
const region = await node(entity, "REGION", "Mumbai", "mumbai");
const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
const towerC = await node(project, "PHASE", "Tower C", "tower_c");
const towerD = await node(project, "PHASE", "Tower D", "tower_d");
const towerE = await node(project, "PHASE", "Tower E", "tower_e");
const towerF = await node(project, "PHASE", "Tower F", "tower_f");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${orgId}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
const FILED = "P52100077001";
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, valid_from, valid_to, verified_at)
  VALUES (${towerC.id}, ${orgId}, 'VERIFIED', ${FILED}, 'MH', current_date - 30, '2029-03-31', now())`;
// A live Brain on Tower C, written straight in: a fixture for the readers'
// rules, and the Brain's own flow has its own suite.
const [v1] = await sql<{ id: string }[]>`
  INSERT INTO brain_versions (org_id, scope_node_id, version, state, published_at, created_by, published_by)
  VALUES (${orgId}, ${towerC.id}, 1, 'DRAFT', NULL, ${admin.id}, NULL) RETURNING id`;
await sql`
  INSERT INTO brain_fields (brain_version_id, org_id, field_key, value)
  VALUES (${v1.id}, ${orgId}, 'price.booking_amount', '150000'),
         (${v1.id}, ${orgId}, 'claims.talking_points', 'Sea facing')`;
await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now(), published_by = ${admin.id} WHERE id = ${v1.id}`;
const liveBefore = await sql`SELECT field_key, value, source_asset FROM brain_fields WHERE brain_version_id = ${v1.id} ORDER BY field_key`;

// ---------------------------------------------------------------------------
// Documents, made here
// ---------------------------------------------------------------------------

const H = 841.89;
const t = (x: number, yTop: number, text: string, size = 11, bold = false): Draw => ({ t: "text", x, y: H - yTop, text, size, bold });
const priceList = pdfDocument([[
  t(50, 60, "SATH HEIGHTS - TOWER C", 18, true),
  t(50, 90, "PRICE LIST (effective 1 October 2026)", 12),
  t(50, 130, "Base rate: Rs 12,500 per sq ft of carpet area"),
  t(50, 150, "Booking amount: Rs 2,00,000"),
  t(50, 190, "Type", 11, true), t(200, 190, "Carpet (sq ft)", 11, true), t(350, 190, "Price", 11, true),
  t(50, 210, "1 BHK"), t(200, 210, "452"), t(350, 210, "Rs 56,50,000"),
  t(50, 230, "2 BHK"), t(200, 230, "682"), t(350, 230, "Rs 85,25,000"),
]], { title: "Price list" });
const certificate = pdfDocument([[
  t(50, 60, "MAHARASHTRA REAL ESTATE REGULATORY AUTHORITY", 14, true),
  t(50, 90, "FORM C: Registration Certificate of Project"),
  t(50, 120, "Project registration number: P52100099999"),
  t(50, 140, "Project: Tower C, Sath Heights"),
  t(50, 170, "The registration shall be valid from 01/10/2023 to 31/12/2027 unless renewed."),
]], { title: "Certificate" });
const brochure = pdfDocument([
  [t(50, 60, "SATH HEIGHTS", 24, true), t(50, 100, "Goregaon West, Mumbai")],
  [t(50, 60, "Why you will love it", 16, true), t(50, 100, "A rooftop infinity pool overlooking the city"), t(50, 120, "Eight minutes from Goregaon station")],
], { title: "Brochure" });
const longAgreement = pdfDocument(
  Array.from({ length: 45 }, (_, i) => [t(50, 60, `Clause ${i + 1}`, 12, true), t(50, 90, "The Promoter shall hand over possession of the Apartment to the Allottee.")]),
  { title: "Agreement" },
);

// A scanned page: Devanagari drawn by @napi-rs/canvas in the bundled Noto
// face, turned into a JPEG, and put in a PDF that holds that picture and no
// text at all, which is what a scanner hands back.
const MARATHI_LINES = [
  "साथ हाइट्स - टॉवर सी",
  "दरपत्रक",
  "मूळ दर: रु. १२,५०० प्रति चौ. फूट",
  "बुकिंग रक्कम: रु. २ लाख",
  "१ बीएचके   ४५२   रु. ५६.५ लाख",
  "२ बीएचके   ६८२   रु. ८५,२५,०००",
];
async function scannedPdf(lines: string[]): Promise<Buffer> {
  const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
  GlobalFonts.registerFromPath(join(process.cwd(), "assets", "fonts", "NotoSansDevanagari-Regular.ttf"), "Scan Devanagari");
  GlobalFonts.registerFromPath(join(process.cwd(), "assets", "fonts", "NotoSans-Regular.ttf"), "Scan Latin");
  const W = 1240;
  const Hpx = 1754;
  const canvas = createCanvas(W, Hpx);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, Hpx);
  ctx.fillStyle = "#161616";
  ctx.font = "42px 'Scan Devanagari', 'Scan Latin'";
  lines.forEach((l, i) => ctx.fillText(l, 100, 160 + i * 100));
  const jpeg = await sharp(Buffer.from(await canvas.encode("png"))).jpeg({ quality: 85 }).toBuffer();
  return jpegPdf(jpeg, W, Hpx);
}
/** A one-page PDF holding one JPEG, filling a page of A4 width. */
function jpegPdf(jpeg: Buffer, w: number, h: number): Buffer {
  const pw = 595.28;
  const ph = +(pw * (h / w)).toFixed(2);
  const content = Buffer.from(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
  const objs: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let at = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]);
    offsets.push(at);
    parts.push(b);
    at += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

type Up = { documentId: string; extractionId: string | null; message: string };
const upload = async (at: { id: string }, kind: DocKind, bytes: Buffer, name: string, type = "application/pdf"): Promise<Up> => {
  const n = (await brainNode(orgId, at.id))!;
  const sha = sha256(bytes);
  const begun = await beginUpload({ orgId, node: n, kind, type, size: bytes.byteLength, sha256: sha, origin: "http://localhost:3000" });
  if (begun.state === "upload") {
    const token = new URL(begun.url).searchParams.get("t")!;
    const target = readUploadToken(token);
    if (!target) throw new Error("upload token did not read");
    await memory.put(target.key, bytes, target.type);
  }
  const done = await finishUpload({ orgId, userId: admin.id, node: n, kind, name, type, size: bytes.byteLength, sha256: sha });
  if (!done.ok) throw new Error(done.message);
  return done;
};

/**
 * File the model's answer under the hash of the exact request the reader
 * will make: the same pages, read by the same code, cut into the same calls.
 */
const answer = async (at: { id: string }, kind: DocKind, bytes: Buffer, type: string, value: unknown, languages: string[] = []) => {
  const n = (await brainNode(orgId, at.id))!;
  const def = docKindDef(kind)!;
  const pageCount = type === "application/pdf" ? Math.min(def.maxPages, 200) : 1;
  const pages: PageText[] = await readPages(bytes, type as "application/pdf", Array.from({ length: pageCount }, (_, i) => i + 1), undefined, { languages });
  const fields = fieldsToRead(def.extractor, n.kind, n.exempt);
  for (const chunk of chunkPages(pages.filter((p) => p.segments.length))) {
    const req = extractRequest({ extractor: EXTRACTORS[def.extractor].key, docLabel: def.label, nodeName: n.name, nodeKind: n.kind, fields, pages: chunk });
    await writeFile(join(fixtures, `extract_${extractRequestId(req)}.json`), JSON.stringify({ value, modelVersion: "gpt-5-mini-fixture", tokensIn: 1200, tokensOut: 600 }));
  }
  return pages;
};

const proposals = (docId: string) => sql<{ id: string; field_key: string; value: string; state: string; in_draft: boolean; page: number; bbox: { x: number; y: number; w: number; h: number }; confidence: string }[]>`
  SELECT id, field_key, value, state, in_draft, page, bbox, confidence FROM brain_proposals WHERE document_id = ${docId} ORDER BY created_at, field_key`;
const draftOf = async (nodeId: string) => {
  const [d] = await sql<{ id: string; version: number }[]>`SELECT id, version FROM brain_versions WHERE scope_node_id = ${nodeId} AND state = 'DRAFT'`;
  if (!d) return null;
  const rows = await sql<{ field_key: string; value: string | null; source_asset: string | null; source_page: number | null; source_bbox: string | null; confidence: string | null; extractor: string | null }[]>`
    SELECT field_key, value, source_asset, source_page, source_bbox, confidence, extractor FROM brain_fields WHERE brain_version_id = ${d.id}`;
  return { ...d, fields: Object.fromEntries(rows.map((r) => [r.field_key, r])) };
};

try {
  console.log("\nA price list is read into the draft");
  const pages = await answer(towerC, "PRICE_LIST", priceList, "application/pdf", {
    facts: [
      { key: "price.base_psf", value: "12500", cites: ["1.3"], confidence: 0.97 },
      { key: "price.booking_amount", value: "200000", cites: ["1.4"], confidence: 0.95 },
      { key: "price.booking_amount", value: "999999", cites: ["1.4"], confidence: 0.9 },
    ],
    units: [
      { config: "1BHK", carpet_sqft: 452, balcony_sqft: null, price_rupees: 5650000, cites: ["1.8", "1.9", "1.10"] },
      { config: "2BHK", carpet_sqft: 682, balcony_sqft: null, price_rupees: 8525000, cites: ["1.11", "1.12", "1.13"] },
    ],
  });
  check("the price list is read off its own text, piece 1.3 being the rate", pages[0].source === "text" && pages[0].segments.find((s) => s.id === "1.3")?.text.includes("12,500"));
  const first = await upload(towerC, "PRICE_LIST", priceList, "Price list Oct 2026.pdf");
  check("uploading queues a reading", !!first.extractionId, first.message);
  const run = await runExtraction(orgId, first.extractionId!);
  check("the reading finishes", run.ok, JSON.stringify(run));
  check("a value the page does not print is dropped", run.ok && run.dropped === 1, JSON.stringify(run));
  const draft = await draftOf(towerC.id);
  check("a new draft is opened, the live version left alone", draft?.version === 2);
  check("the empty rate is filled from the page", draft?.fields["price.base_psf"]?.value === "12500");
  const psf = draft?.fields["price.base_psf"];
  const bbox = psf?.source_bbox ? JSON.parse(psf.source_bbox) : null;
  check("with the document, the page and the box it came from", psf?.source_asset === first.documentId && psf?.source_page === 1 && bbox && bbox.x > 0.05 && bbox.x < 0.15 && bbox.w > 0.3, JSON.stringify(psf));
  check("and the reader and how sure it was", psf?.extractor === "price_list" && Number(psf?.confidence) === 0.97);
  check("the booking amount somebody set is not replaced", draft?.fields["price.booking_amount"]?.value === "150000");
  const ps = await proposals(first.documentId);
  check("the rate waits for a person, in the draft", ps.some((p) => p.field_key === "price.base_psf" && p.state === "PROPOSED" && p.in_draft));
  check("the different booking amount is proposed beside it, not in it", ps.some((p) => p.field_key === "price.booking_amount" && p.value === "200000" && p.state === "PROPOSED" && !p.in_draft));
  const liveAfter = await sql`SELECT field_key, value, source_asset FROM brain_fields WHERE brain_version_id = ${v1.id} ORDER BY field_key`;
  const [v1state] = await sql<{ state: string }[]>`SELECT state FROM brain_versions WHERE id = ${v1.id}`;
  check("the published version is untouched", JSON.stringify(liveAfter) === JSON.stringify(liveBefore) && v1state.state === "PUBLISHED");
  const [trail] = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'brain.document_added' LIMIT 1`;
  check("the audit row holds no file name", !JSON.stringify(trail.metadata).includes("Price list"));

  console.log("\nThe same bytes twice are one document");
  const n = (await brainNode(orgId, towerC.id))!;
  const again = await beginUpload({ orgId, node: n, kind: "PRICE_LIST", type: "application/pdf", size: priceList.byteLength, sha256: sha256(priceList), origin: "http://localhost:3000" });
  check("the same file here is answered without a byte sent", again.state === "exists" && again.documentId === first.documentId);
  const nd = (await brainNode(orgId, towerD.id))!;
  const elsewhere = await beginUpload({ orgId, node: nd, kind: "PRICE_LIST", type: "application/pdf", size: priceList.byteLength, sha256: sha256(priceList), origin: "http://localhost:3000" });
  check("and on another tower names where it is", elsewhere.state === "exists" && elsewhere.message.includes("Tower C"));
  const twice = await finishUpload({ orgId, userId: admin.id, node: n, kind: "PRICE_LIST", name: "copy.pdf", type: "application/pdf", size: priceList.byteLength, sha256: sha256(priceList) });
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM brain_documents WHERE org_id = ${orgId} AND sha256 = ${sha256(priceList)}`;
  check("uploading the same bytes twice gives one row", twice.ok && twice.documentId === first.documentId && count.n === 1);
  check("the stored object is named by its hash", [...store.keys()].some((k) => k.startsWith(`org/${orgId}/project/`) && k.endsWith(`/doc/${sha256(priceList)}`)));

  console.log("\nA RERA certificate with a number nobody filed");
  await answer(towerC, "RERA_CERTIFICATE", certificate, "application/pdf", {
    facts: [
      { key: "rera.registration_no", value: "P52100099999", cites: ["1.3"], confidence: 0.99 },
      { key: "rera.declared_completion", value: "2027-12-31", cites: ["1.5"], confidence: 0.96 },
    ],
  });
  const cert = await upload(towerC, "RERA_CERTIFICATE", certificate, "Form C.pdf");
  const certRun = await runExtraction(orgId, cert.extractionId!);
  check("the certificate is read", certRun.ok, JSON.stringify(certRun));
  const d2 = await draftOf(towerC.id);
  check("the draft keeps the filed number", d2?.fields["rera.registration_no"]?.value === FILED);
  const view = (await loadDocuments(orgId, towerC.id))!;
  const wrong = view.review.find((r) => r.field === "rera.registration_no");
  check("a wrong RERA number is flagged", wrong?.flags.some((f) => f.code === "REGISTRATION_MISMATCH" && f.tone === "risk"), JSON.stringify(wrong?.flags));
  check("and may not be accepted", !!wrong?.blocked);
  const refused = await decideProposal({ orgId, userId: admin.id, proposalId: wrong!.id, decision: { kind: "accept" } });
  check("the server refuses it whatever the screen showed", !refused.ok && refused.message.includes(FILED), JSON.stringify(refused));
  const completion = view.review.find((r) => r.field === "rera.declared_completion");
  check("a completion date the filing does not hold is flagged", completion?.flags.some((f) => f.code === "COMPLETION_DIFFERS"));
  check("the queue puts the least sure first", view.review[0].confidence <= view.review[view.review.length - 1].confidence);

  console.log("\nSigning waits for a person");
  const unsigned = await signGroup({ orgId, actorUserId: admin.id, nodeId: towerC.id, group: "PRICE", expectedHash: "" });
  check("a group holding an unchecked value is not signed", !unsigned.ok && unsigned.code === "UNREVIEWED", JSON.stringify(unsigned));
  const summary = await documentSummary(orgId, towerC.id);
  check("the Brain page is told how many wait", summary.toCheck >= 3 && summary.unreviewedInDraft === 2, JSON.stringify(summary));
  const rate = (await proposals(first.documentId)).find((p) => p.field_key === "price.base_psf")!;
  const accepted = await decideProposal({ orgId, userId: admin.id, proposalId: rate.id, decision: { kind: "accept" } });
  check("the rate is accepted", accepted.ok, JSON.stringify(accepted));
  const signed = await signGroup({ orgId, actorUserId: admin.id, nodeId: towerC.id, group: "PRICE", expectedHash: "" });
  check("and then the price signs", signed.ok, JSON.stringify(signed));
  const corrected = await decideProposal({ orgId, userId: admin.id, proposalId: completion!.id, decision: { kind: "correct", value: "2029-03-31" } });
  const d3 = await draftOf(towerC.id);
  check("a corrected value goes in with its page kept", corrected.ok && d3?.fields["rera.declared_completion"]?.value === "2029-03-31" && d3?.fields["rera.declared_completion"]?.source_page === 1 && d3?.fields["rera.declared_completion"]?.confidence === null, JSON.stringify(d3?.fields["rera.declared_completion"]));
  const rejected = await decideProposal({ orgId, userId: admin.id, proposalId: wrong!.id, decision: { kind: "reject" } });
  check("the wrong number is rejected and the draft keeps the filed one", rejected.ok && (await draftOf(towerC.id))?.fields["rera.registration_no"]?.value === FILED);
  const twiceDecided = await decideProposal({ orgId, userId: admin.id, proposalId: wrong!.id, decision: { kind: "accept" } });
  check("a decided value is not decided again", !twiceDecided.ok);

  console.log("\nReading again supersedes, never overwrites");
  const re = await queueExtraction({ orgId, userId: admin.id, documentId: first.documentId });
  check("a second reading is queued", re.ok && !re.already);
  const reRun = await runExtraction(orgId, (re as { extractionId: string }).extractionId);
  check("and finishes", reRun.ok, JSON.stringify(reRun));
  const after = await proposals(first.documentId);
  check("the earlier undecided value is superseded and kept", after.some((p) => p.field_key === "price.booking_amount" && p.state === "SUPERSEDED") && after.some((p) => p.field_key === "price.booking_amount" && p.state === "PROPOSED"));
  check("the accepted rate stays accepted, and the new reading matches it", after.some((p) => p.field_key === "price.base_psf" && p.state === "ACCEPTED") && after.some((p) => p.field_key === "price.base_psf" && p.state === "MATCHED"));
  check("the draft's rate is the same value", (await draftOf(towerC.id))?.fields["price.base_psf"]?.value === "12500");

  console.log("\nFlats on the price list against the tower's unit types");
  await addUnitType({ orgId, actorUserId: admin.id, nodeId: towerC.id, config: "2BHK", variant: null, carpetAreaSqft: 682, balconyAreaSqft: null, startingPrice: null });
  const units = (await loadDocuments(orgId, towerC.id))!.documents.find((d) => d.id === first.documentId)!.units;
  check("a flat on file at the signed rate matches", units.find((u) => u.row.config === "2BHK")?.status === "MATCHES", JSON.stringify(units));
  check("a flat nobody recorded is said to be", units.find((u) => u.row.config === "1BHK")?.status === "NOT_RECORDED");

  console.log("\nA picture of a page is read by OCR");
  const jpg = (await renderPreview(priceList, "application/pdf", 1))!;
  const ocrPages = await answer(towerD, "PRICE_LIST", jpg, "image/jpeg", {
    facts: [{ key: "price.base_psf", value: "12500", cites: ["1.3"], confidence: 0.9 }],
    units: [],
  });
  check("the picture is read by OCR into the same pieces", ocrPages[0].source === "ocr" && ocrPages[0].segments.find((s) => s.id === "1.3")?.text.includes("12,500"), JSON.stringify(ocrPages[0].segments.slice(0, 4)));
  const pic = await upload(towerD, "PRICE_LIST", jpg, "price-list-photo.jpg", "image/jpeg");
  const picRun = await runExtraction(orgId, pic.extractionId!);
  const dD = await draftOf(towerD.id);
  check("and its value lands with a page and a box", picRun.ok && dD?.fields["price.base_psf"]?.value === "12500" && dD?.fields["price.base_psf"]?.source_page === 1, JSON.stringify({ picRun, f: dD?.fields["price.base_psf"] }));
  const [ocrCount] = await sql<{ ocr_pages: number }[]>`SELECT ocr_pages FROM brain_extractions WHERE id = ${pic.extractionId}`;
  check("the reading records the page it had to OCR", ocrCount.ocr_pages === 1);
  await saveGroup({ orgId, actorUserId: admin.id, nodeId: towerD.id, group: "PRICE", input: { "price.base_psf": "13000" } });
  const edited = (await proposals(pic.documentId)).find((p) => p.field_key === "price.base_psf");
  const dD2 = await draftOf(towerD.id);
  check("changing it in the editor corrects it, and drops the page it no longer matches", edited?.state === "CORRECTED" && dD2?.fields["price.base_psf"]?.source_asset === null);

  console.log("\nA Marathi price list is read off its own Devanagari text");
  // Made by scripts/make-devanagari-fixture.mjs: Noto Sans Devanagari, printed by Chromium.
  const marathi = await readFile(join(process.cwd(), "db", "fixtures", "extract", "marathi-price-list.pdf"));
  const mPages = await readPages(marathi, "application/pdf", [1]);
  const segs = mPages[0].segments;
  const seg = (needle: string) => segs.find((s) => s.text.includes(needle))?.id ?? "missing";
  check("the page is read from its text layer, not by OCR", mPages[0].source === "text", mPages[0].source);
  check("its Devanagari is kept, words and digits", segs.some((s) => s.text.includes("बीएचके")) && segs.some((s) => s.text.includes("१२,५००")), JSON.stringify(segs.map((s) => s.text)));
  check("a conjunct set with no width is kept, not dropped", segs.some((s) => s.text.startsWith("प्रकार")) && segs.some((s) => s.text.startsWith("रु. ५६.५")), JSON.stringify(segs.map((s) => s.text)));
  check("and a glyph the PDF names no letter for leaves no control character behind", !segs.some((s) => /[\u0000-\u001f]/.test(s.text)));
  await answer(towerE, "PRICE_LIST", marathi, "application/pdf", {
    facts: [
      { key: "price.base_psf", value: "12500", cites: [seg("१२,५००")], confidence: 0.95 },
      { key: "price.booking_amount", value: "200000", cites: [seg("२ लाख")], confidence: 0.93 },
      { key: "price.booking_amount", value: "250000", cites: [seg("२ लाख")], confidence: 0.5 },
    ],
    units: [
      { config: "1BHK", carpet_sqft: 452, balcony_sqft: null, price_rupees: 5650000, cites: [seg("१ बीएचके"), seg("४५२"), seg("५६.५")] },
      { config: "2BHK", carpet_sqft: 682, balcony_sqft: null, price_rupees: 8525000, cites: [seg("२ बीएचके"), seg("६८२"), seg("८५,२५,०००")] },
    ],
  });
  const mUp = await upload(towerE, "PRICE_LIST", marathi, "Darpatrak.pdf");
  const mRun = await runExtraction(orgId, mUp.extractionId!);
  check("the reading finishes, the one amount the page does not print dropped", mRun.ok && mRun.dropped === 1, JSON.stringify(mRun));
  const dE = await draftOf(towerE.id);
  check("the rate printed in Devanagari digits fills the draft", dE?.fields["price.base_psf"]?.value === "12500", JSON.stringify(dE?.fields["price.base_psf"]));
  check("and \"२ लाख\" is read as Rs 2,00,000", dE?.fields["price.booking_amount"]?.value === "200000", JSON.stringify(dE?.fields["price.booking_amount"]));
  const eUnits = (await loadDocuments(orgId, towerE.id))!.documents.find((d) => d.id === mUp.documentId)!.units;
  check("both flats are read off their Devanagari rows, \"रु. ५६.५ लाख\" as Rs 56,50,000", eUnits.length === 2 && eUnits.some((u) => u.row.config === "1BHK" && u.row.price === 5650000), JSON.stringify(eUnits.map((u) => u.row)));

  console.log("\nA scanned Marathi price list is read by OCR in Devanagari");
  check("an English picture is read in English and not read again", ocrPages[0].ocr === "eng", String(ocrPages[0].ocr));
  // The same price list as the text-layer one above, drawn to a picture in
  // Noto Sans Devanagari and put in a PDF as a JPEG and nothing else, the way
  // a scanner makes one.
  const scan = await scannedPdf(MARATHI_LINES);
  {
    const seen: string[] = [];
    useVisionReader(async (req) => {
      seen.push(req.model);
      return { ok: true, value: { lines: [{ text: "FLAT PLAN - 02", x: 0.4, y: 0.05, w: 0.2, h: 0.04 }, { text: "1013.6 SQ FT", x: 0.42, y: 0.8, w: 0.16, h: 0.04 }, { text: "  ", x: 0, y: 0, w: 0, h: 0 }] }, usage: { tokensIn: 1200, tokensOut: 300 } };
    });
    const vPages = await readPages(scan, "application/pdf", [1]);
    useVisionReader(null);
    check("a page with no text layer is read by the vision model, line by line, with its place", vPages[0]?.source === "ocr" && vPages[0].segments.map((s) => s.text).join("|") === "FLAT PLAN - 02|1013.6 SQ FT", JSON.stringify(vPages[0]?.segments));
    check("and what it cost rides on the page", (vPages[0]?.usd ?? 0) > 0 && vPages[0]?.ocr === "gpt-5-mini" && seen.length === 1, JSON.stringify({ usd: vPages[0]?.usd, ocr: vPages[0]?.ocr }));
  }
  const beforeBrief = await readPages(scan, "application/pdf", [1]);
  check("a page with no text layer is read by OCR, and read again in Hindi and Marathi", beforeBrief[0].source === "ocr" && beforeBrief[0].ocr === "hin+mar", JSON.stringify({ s: beforeBrief[0].source, o: beforeBrief[0].ocr }));
  // The organisation's briefs are written in Marathi, so the Marathi model reads it.
  await sql`
    INSERT INTO campaign_briefs (org_id, scope_node_id, name, languages)
    VALUES (${orgId}, ${project.id}, 'Marathi launch', ${["Marathi", "English"]})`;
  const sPages = await readPages(scan, "application/pdf", [1], undefined, { languages: ["Marathi", "English"] });
  const sSegs = sPages[0].segments;
  const sSeg = (needle: string) => sSegs.find((s) => s.text.includes(needle))?.id ?? "missing";
  check("with the Marathi model when the briefs are in Marathi", sPages[0].source === "ocr" && sPages[0].ocr === "mar", String(sPages[0].ocr));
  check("its Devanagari words and digits come through", sSegs.some((s) => s.text.includes("बीएचके")) && sSegs.some((s) => s.text.includes("१२,५००")) && sSegs.some((s) => s.text.includes("८५,२५,०००")), JSON.stringify(sSegs.map((s) => s.text)));
  check("and the reader was sure of them", sSegs.every((s) => s.conf >= 0.6), JSON.stringify(sSegs.map((s) => s.conf)));
  // The model's answer, cited against the pieces the scan really produced.
  await answer(towerF, "PRICE_LIST", scan, "application/pdf", {
    facts: [
      { key: "price.base_psf", value: "12500", cites: [sSeg("१२,५००")], confidence: 0.95 },
      { key: "price.booking_amount", value: "200000", cites: [sSeg("२ लाख")], confidence: 0.93 },
    ],
    units: [{ config: "2BHK", carpet_sqft: 682, balcony_sqft: null, price_rupees: 8525000, cites: [sSeg("६८२"), sSeg("८५,२५,०००")] }],
  }, ["Marathi", "English"]);
  const sUp = await upload(towerF, "PRICE_LIST", scan, "Darpatrak scan.pdf");
  const sRun = await runExtraction(orgId, sUp.extractionId!);
  check("the reading finishes", sRun.ok, JSON.stringify(sRun));
  const dF = await draftOf(towerF.id);
  check("the rate read off the scan fills the draft", dF?.fields["price.base_psf"]?.value === "12500", JSON.stringify(dF?.fields["price.base_psf"]));
  check("and \"२ लाख\" off the scan is Rs 2,00,000", dF?.fields["price.booking_amount"]?.value === "200000", JSON.stringify(dF?.fields["price.booking_amount"]));
  check("with the page and a box on it", dF?.fields["price.base_psf"]?.source_page === 1 && !!dF?.fields["price.base_psf"]?.source_bbox);
  const [sCount] = await sql<{ ocr_pages: number }[]>`SELECT ocr_pages FROM brain_extractions WHERE id = ${sUp.extractionId}`;
  check("the reading records the page it had to OCR", sCount.ocr_pages === 1);
  const [sLayout] = await sql<{ layout: { pages: PageText[] } }[]>`SELECT layout FROM brain_documents WHERE id = ${sUp.documentId}`;
  check("and which models read it", sLayout.layout.pages[0]?.ocr === "mar", JSON.stringify(sLayout.layout.pages[0]?.ocr));

  console.log("\nRemoving a document");
  await answer(towerD, "BROCHURE", brochure, "application/pdf", {
    facts: [
      { key: "claims.location", value: "Goregaon West", cites: ["1.2"], confidence: 0.9 },
      { key: "claims.talking_points", value: "Rooftop infinity pool", cites: ["2.2"], confidence: 0.9 },
      { key: "claims.talking_points", value: "Eight minutes from Goregaon station", cites: ["2.3"], confidence: 0.92 },
    ],
  });
  const bro = await upload(towerD, "BROCHURE", brochure, "Brochure.pdf");
  await runExtraction(orgId, bro.extractionId!);
  const withLines = await draftOf(towerD.id);
  check("a brochure's selling points fill an empty list, one line each", withLines?.fields["claims.talking_points"]?.value === "Rooftop infinity pool\nEight minutes from Goregaon station", JSON.stringify(withLines?.fields["claims.talking_points"]));
  const picture = await pagePreview(orgId, (await documentFile(orgId, bro.documentId))!, 2);
  const kept = (await documentFile(orgId, bro.documentId))!.previews["2"];
  check("a page is drawn once for the review screen, and kept", !!picture && picture[0] === 0xff && !!kept && store.has(kept));
  const removed = await removeDocument({ orgId, userId: admin.id, documentId: bro.documentId });
  const without = await draftOf(towerD.id);
  check("removing it takes its unchecked values out of the draft", removed.ok && !without?.fields["claims.talking_points"]?.value && !without?.fields["claims.location"]?.value, JSON.stringify(removed));
  check("and its file and its pages out of the store", ![...store.keys()].some((k) => k.endsWith(`/doc/${sha256(brochure)}`)) && !store.has(kept));
  const keep = await removeDocument({ orgId, userId: admin.id, documentId: cert.documentId });
  check("a document a value was taken from is kept", !keep.ok);
  const regionNode = (await brainNode(orgId, region.id))!;
  const atRegion = await beginUpload({ orgId, node: regionNode, kind: "BROCHURE", type: "application/pdf", size: brochure.byteLength, sha256: sha256(brochure), origin: "http://localhost:3000" });
  check("documents are filed on a project or a tower, not a region", atRegion.state === "refused");

  console.log("\nRefused before spending");
  let calls = 0;
  useExtractDriver(async () => {
    calls += 1;
    return { ok: true, value: { facts: [] }, modelVersion: "injected", tokensIn: 1000, tokensOut: 200_000 };
  });
  const agr = await upload(towerC, "AGREEMENT", longAgreement, "Agreement.pdf");
  const agrRun = await runExtraction(orgId, agr.extractionId!);
  const [meter] = await sql<{ state: string; calls: number; cost_usd: string; error_code: string | null }[]>`
    SELECT state, calls, cost_usd, error_code FROM brain_extractions WHERE id = ${agr.extractionId}`;
  check("a reading that would pass its budget stops before the next call", !agrRun.ok && meter.error_code === "BUDGET" && calls === 1 && meter.calls === 1, JSON.stringify({ agrRun, meter, calls }));
  check("and what it did spend is on the meter", Number(meter.cost_usd) > 0.3);
  useExtractDriver(null);
  const third = await queueExtraction({ orgId, userId: admin.id, documentId: first.documentId });
  if (third.ok) await runExtraction(orgId, third.extractionId);
  const fourth = await queueExtraction({ orgId, userId: admin.id, documentId: first.documentId });
  check("a document read three times is refused a fourth, before anything is asked", !fourth.ok, JSON.stringify(fourth));
  const eleven = pdfDocument(Array.from({ length: 11 }, (_, i) => [t(50, 60, `Page ${i + 1}`)]), { title: "x" });
  const nn = (await brainNode(orgId, towerC.id))!;
  const begunLong = await beginUpload({ orgId, node: nn, kind: "RERA_CERTIFICATE", type: "application/pdf", size: eleven.byteLength, sha256: sha256(eleven), origin: "http://localhost:3000" });
  if (begunLong.state === "upload") await memory.put(readUploadToken(new URL(begunLong.url).searchParams.get("t")!)!.key, eleven, "application/pdf");
  const tooLong = await finishUpload({ orgId, userId: admin.id, node: nn, kind: "RERA_CERTIFICATE", name: "x.pdf", type: "application/pdf", size: eleven.byteLength, sha256: sha256(eleven) });
  check("a certificate of eleven pages is refused, and its file taken back out", !tooLong.ok && tooLong.message.includes("10 pages") && ![...store.keys()].some((k) => k.endsWith(`/doc/${sha256(eleven)}`)), JSON.stringify(tooLong));
  // A project that has spent its month on reading is refused before a call.
  await sql`
    INSERT INTO brain_extractions (org_id, document_id, scope_node_id, extractor, state, calls, cost_usd, finished_at)
    VALUES (${orgId}, ${pic.documentId}, ${towerD.id}, 'price_list', 'DONE', 1, 8, now())`;
  const month = await queueExtraction({ orgId, userId: admin.id, documentId: cert.documentId });
  check("a project past its month's reading is refused, and the document says why", !month.ok && month.message.includes("month"), JSON.stringify(month));
  const certRow = (await loadDocuments(orgId, towerC.id))!.documents.find((d) => d.id === cert.documentId)!;
  check("the refusal is shown on the document", certRow.reading?.state === "FAILED" && !!certRow.reading?.error?.includes("month"));
  const bad = readUploadToken("eyJrIjoib3JnL3gifQ.forged");
  check("a forged upload token opens nothing", bad === null);

  console.log("\nA logo lifted off a brochure page");
  {
    const { cutOutLogo, whiteLogo, horizontalLogo, logoColours } = await import("../src/lib/logo-cut.ts");
    // A gold mark above a dark name, on a textured grey, cut tight so the mark touches the top.
    const W = 240;
    const H = 200;
    const px = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const g = 150 + ((i * 7919) % 17) - 8;
      px.set([g, g, g], i * 3);
    }
    const fill = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.set(c, (y * W + x) * 3);
    };
    fill(80, 0, 160, 110, [176, 125, 58]);
    fill(110, 40, 130, 70, [150, 150, 150]);
    fill(40, 150, 200, 180, [20, 20, 20]);
    const logo = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const cut = await cutOutLogo(logo);
    const { data, info } = await sharp(cut.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    check("its textured background is taken out, a hole in the mark too, and it is cut to what is drawn",
      cut.cut && info.width === 160 && info.height === 180 && alpha(0, 0) === 0 && alpha(70, 60) === 0 && alpha(60, 20) === 255 && alpha(10, 165) === 255,
      JSON.stringify({ cut: cut.cut, w: info.width, h: info.height, a: [alpha(0, 0), alpha(70, 60), alpha(60, 20), alpha(10, 165)] }));
    const white = await sharp(await whiteLogo(cut.png)).ensureAlpha().raw().toBuffer();
    check("the single-colour mark is white where the logo is drawn", white[(20 * info.width + 60) * 4] === 255 && white[(165 * info.width + 10) * 4 + 2] === 255 && white[(20 * info.width + 60) * 4 + 3] === 255);
    const side = await horizontalLogo(cut.png);
    const sideMeta = side ? await sharp(side).metadata() : null;
    check("a mark above a name is laid out side by side", !!sideMeta && sideMeta.width! > sideMeta.height! * 2, JSON.stringify(sideMeta && { w: sideMeta.width, h: sideMeta.height }));
    check("its brand colour is the gold it is drawn in, its accent the dark ink", await logoColours(cut.png), { primary: "#B07D3A", accent: "#141414" });
  }

  console.log("\nPublishing still asks");
  const published = await publishBrain({ orgId, actorUserId: admin.id, nodeId: towerD.id });
  check("a draft with nothing signed is not published", !published.ok);
} finally {
  useExtractDriver(null);
  useStorage(null);
  await stopOcr();
  await rm(fixtures, { recursive: true, force: true });
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM orgs WHERE id = ${orgId}`;
  await sql`DELETE FROM users WHERE id = ${admin.id}`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
