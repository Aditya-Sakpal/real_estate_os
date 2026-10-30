// The pixel gate, on fixture rasters: every check a finished advertisement is
// held to, read off pictures built here with each fault put in on purpose.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-pixel.mts
//
// Nothing here calls anybody. The QR is decoded by jsQR and the words are
// read by Tesseract, both in this process; the database is not touched. The
// pictures are drawn with the same Pango and Noto faces the compositor uses,
// and two are made by the compositor itself (`renderFrame()`), because the
// gate passing our own output is the first thing it has to do.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import QRCode from "qrcode";
import type { FrameExpect, PixelFinding } from "../src/lib/pixel-rules.ts";

const { checkFrame, gatePost, compareRegion, sha256 } = await import("../src/lib/pixel.ts");
const {
  MAHARERA_RULE,
  pixelRefusal,
  regionChanged,
  sampleTimes,
  verdictOf,
} = await import("../src/lib/pixel-rules.ts");
const { stopOcr } = await import("../src/lib/ocr.ts");
const { renderFrame, flatten, qrOnly } = await import("../src/lib/compose.ts");
const { stampPartner } = await import("../src/lib/cobrand.ts");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

const DIR = mkdtempSync(join(tmpdir(), "salesdesk-pixel-"));
const REG = "P52100012345";
const PAYLOAD = `https://maharera.maharashtra.gov.in/projects/${REG}`;
const FONTS = join(process.cwd(), "assets", "fonts");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const expect: FrameExpect = {
  registrationNo: REG,
  authority: MAHARERA_RULE,
  qrPayload: PAYLOAD,
  phone: "+91 98765 00000",
  website: "sathheights.example",
  render: true,
  contact: true,
  configurations: [
    { config: "2BHK", label: "2 BHK", startingPrice: 2_18_24_000 },
    { config: "1BHK", label: "1 BHK", startingPrice: 1_45_00_000 },
  ],
  money: [5_00_000],
  registrationDaysLeft: 400,
};

// ---------------------------------------------------------------------------
// Drawing a fixture
// ---------------------------------------------------------------------------

async function text(t: string, o: { size: number; bold?: boolean; color: string; devanagari?: boolean }) {
  const face = o.devanagari ? `NotoSansDevanagari-${o.bold ? "Bold" : "Regular"}.ttf` : `NotoSans-${o.bold ? "Bold" : "Regular"}.ttf`;
  const family = o.devanagari ? "Noto Sans Devanagari" : "Noto Sans";
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${o.color}">${esc(t)}</span>`,
      fontfile: join(FONTS, face),
      font: `${family} ${o.bold ? "Bold " : ""}${o.size}`,
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buf: data, w: info.width, h: info.height };
}

/** A sky over a row of towers: a picture, not a flat colour. */
async function backdrop(w: number, h: number, sky: "blue" | "pale") {
  const [top, bottom] = sky === "blue" ? ["#3f7fc4", "#a9c9e8"] : ["#d4e4f3", "#e8f0f8"];
  const towers = [0.08, 0.3, 0.55, 0.74]
    .map((x, i) => {
      const tw = w * 0.14;
      const th = h * (0.35 + (i % 2) * 0.12);
      return `<rect x="${x * w}" y="${h - th}" width="${tw}" height="${th}" fill="${i % 2 ? "#6b6f76" : "#8a8479"}"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#s)"/>${towers}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

type Spec = {
  w?: number;
  h?: number;
  sky?: "blue" | "pale";
  /** The block: where, whether on a white panel, the number as printed and its size. */
  block?: { x: number; y: number; panel: boolean; reg: string; size: number; color: string; payload?: string; qr: number } | null;
  foot?: { phoneSize: number; impression: boolean } | null;
  price?: string | null;
  headline?: { text: string; devanagari?: boolean } | null;
};

async function frame(spec: Spec): Promise<Buffer> {
  const W = spec.w ?? 1080;
  const H = spec.h ?? 1080;
  const layers: sharp.OverlayOptions[] = [];
  const b = spec.block;
  if (b) {
    const qr = await QRCode.toBuffer(b.payload ?? PAYLOAD, { width: b.qr, margin: 1 });
    const qrMeta = await sharp(qr).metadata();
    const label = await text("MahaRERA No.", { size: Math.round(b.size * 0.62), color: b.color });
    const reg = await text(b.reg, { size: b.size, bold: true, color: b.color });
    const web = await text("maharera.maharashtra.gov.in", { size: b.size, color: b.color });
    const pad = 14;
    const pw = pad * 3 + qrMeta.width! + Math.max(label.w, reg.w);
    const ph = pad * 3 + Math.max(qrMeta.height!, label.h + reg.h + 6) + web.h;
    const pw2 = Math.max(pw, web.w + pad * 2);
    if (b.panel) {
      layers.push({
        input: await sharp({ create: { width: pw2, height: ph, channels: 4, background: "#ffffff" } }).png().toBuffer(),
        left: b.x,
        top: b.y,
      });
    }
    layers.push({ input: qr, left: b.x + pad, top: b.y + pad });
    layers.push({ input: label.buf, left: b.x + pad * 2 + qrMeta.width!, top: b.y + pad + 10 });
    layers.push({ input: reg.buf, left: b.x + pad * 2 + qrMeta.width!, top: b.y + pad + 16 + label.h });
    layers.push({ input: web.buf, left: b.x + pad, top: b.y + pad * 2 + Math.max(qrMeta.height!, label.h + reg.h + 6) });
  }
  if (spec.headline) {
    const t = await text(spec.headline.text, { size: 64, bold: true, color: "#ffffff", devanagari: spec.headline.devanagari });
    layers.push({ input: t.buf, left: 60, top: Math.round(H * 0.55) });
  }
  if (spec.price) {
    const t = await text(spec.price, { size: 40, bold: true, color: "#ffffff" });
    layers.push({ input: t.buf, left: 60, top: Math.round(H * 0.55) + 90 });
  }
  const f = spec.foot;
  if (f) {
    const bandH = Math.round(H * 0.1);
    layers.push({ input: await sharp({ create: { width: W, height: bandH, channels: 4, background: "#10131a" } }).png().toBuffer(), left: 0, top: H - bandH });
    const contact = await text("+91 98765 00000  ·  sathheights.example", { size: f.phoneSize, bold: true, color: "#ffffff" });
    layers.push({ input: contact.buf, left: 40, top: H - bandH + 12 });
    if (f.impression) {
      const small = await text("Artist's impression. Prices valid for 30 days.", { size: 15, color: "#e8e8e8" });
      layers.push({ input: small.buf, left: 40, top: H - bandH + 18 + contact.h });
    }
  }
  return sharp(await backdrop(W, H, spec.sky ?? "blue")).composite(layers).jpeg({ quality: 88 }).toBuffer();
}

const GOOD: Spec = {
  block: { x: 640, y: 40, panel: true, reg: REG, size: 26, color: "#111111", qr: 150 },
  foot: { phoneSize: 20, impression: true },
  price: "2 BHK starting at ₹2.19 Cr*",
  headline: { text: "Sea facing homes" },
};

const codes = (f: PixelFinding[]) => f.map((x) => x.code).sort();
const run = async (name: string, spec: Spec, e: FrameExpect = expect) => {
  const bytes = await frame(spec);
  writeFileSync(join(DIR, `${name}.jpg`), bytes);
  return checkFrame(bytes, e);
};

// ---------------------------------------------------------------------------
console.log("\na post that carries everything");

const good = await run("good", GOOD);
check("reads clean", codes(good), []);
check("and passes", verdictOf(good), "PASS");

// ---------------------------------------------------------------------------
console.log("\nthe QR");

const small = await run("qr-small", { ...GOOD, block: { ...GOOD.block!, qr: 64 } });
check("a QR too small to scan as a buyer meets it fails", codes(small).includes("QR_TOO_SMALL") || codes(small).includes("QR_UNREADABLE"), true);
check("and fails the post", verdictOf(small), "FAIL");
const other = await run("qr-other", { ...GOOD, block: { ...GOOD.block!, payload: "https://maharera.maharashtra.gov.in/projects/P52100099999" } });
check("a QR that opens another phase fails", codes(other), ["QR_WRONG"]);
const none = await checkFrame(await frame({ ...GOOD, block: { ...GOOD.block!, qr: 150, payload: undefined } }), { ...expect, qrPayload: "https://maharera.maharashtra.gov.in/projects/elsewhere" });
check("a QR that is not the approved lockup's fails", codes(none), ["QR_WRONG"]);

// ---------------------------------------------------------------------------
console.log("\nthe registration block");

const outside = await run("outside", { ...GOOD, block: { ...GOOD.block!, x: 40, y: 560 }, headline: null, price: null });
check("a block outside the upper-right quarter fails", codes(outside), ["LOCKUP_OUTSIDE"]);
const smaller = await run("smaller", { ...GOOD, block: { ...GOOD.block!, size: 14 }, foot: { phoneSize: 24, impression: true } });
check("a number smaller than the phone fails", codes(smaller), ["REG_SMALL"]);
const pale = await run("pale", { ...GOOD, sky: "pale", block: { ...GOOD.block!, panel: false, color: "#9fb3c8" } });
check("a pale block on a pale sky fails for contrast", codes(pale).includes("CONTRAST_LOW"), true);
check("and fails the post", verdictOf(pale), "FAIL");
const misprint = await run("misprint", { ...GOOD, block: { ...GOOD.block!, reg: "P521OO012345", size: 30 } });
check("a number printed with O for 0 fails as a misprint", codes(misprint), ["REG_MISPRINT"]);
const wrong = await run("wrong", { ...GOOD, block: { ...GOOD.block!, reg: "P52100012346" } });
check("another number fails", codes(wrong), ["REG_WRONG"]);

// ---------------------------------------------------------------------------
console.log("\nthe small print and the prices");

const noNote = await run("no-impression", { ...GOOD, foot: { phoneSize: 20, impression: false } });
check("a render without the artist's impression line fails", codes(noNote), ["NO_IMPRESSION"]);
check("a photograph needs none", codes(await checkFrame(await frame({ ...GOOD, foot: { phoneSize: 20, impression: false } }), { ...expect, render: false })), []);
const wrongPrice = await run("wrong-price", { ...GOOD, price: "1 BHK starting at ₹2.19 Cr*" });
check("the 2 BHK's price beside the 1 BHK fails", codes(wrongPrice), ["PRICE_WRONG_CONFIG"]);
const unknownPrice = await run("unknown-price", { ...GOOD, price: "2 BHK starting at ₹1.99 Cr*" });
check("a price nobody approved fails", codes(unknownPrice), ["PRICE_UNKNOWN"]);

// ---------------------------------------------------------------------------
console.log("\nwhat a machine cannot settle");

const lapsing = await checkFrame(await frame(GOOD), { ...expect, registrationDaysLeft: 20 });
check("a registration inside thirty days of lapsing holds", [codes(lapsing), verdictOf(lapsing)], [["REG_LAPSING"], "HOLD"]);
const foreign = await checkFrame(await frame({ ...GOOD, block: { ...GOOD.block!, payload: "https://example.com/P52100012345" } }), { ...expect, qrPayload: "https://example.com/P52100012345" });
check("an approved QR that opens no authority page holds", [codes(foreign), verdictOf(foreign)], [["QR_NOT_AUTHORITY"], "HOLD"]);
const exempt = await checkFrame(await frame({ ...GOOD, block: null }), { ...expect, registrationNo: null, qrPayload: null });
check("an exempt tower's ad carries no block and passes", codes(exempt), []);

// ---------------------------------------------------------------------------
console.log("\nother scripts and other shapes");

const hindi = await run("devanagari", { ...GOOD, headline: { text: "समुद्र की ओर घर", devanagari: true } });
check("a Devanagari post passes", codes(hindi), []);
const reelFrame = await frame({ w: 1080, h: 1920, block: { x: 640, y: 40, panel: true, reg: REG, size: 26, color: "#111111", qr: 150 }, foot: null, headline: { text: "Ghar jahan samundar dikhe" } });
writeFileSync(join(DIR, "reel-frame.jpg"), reelFrame);
check("a reel frame with the block and no phone passes", codes(await checkFrame(reelFrame, { ...expect, contact: false, render: false })), []);
check("but where the phone should be, its absence fails", codes(await checkFrame(reelFrame, { ...expect, render: false })), ["CONTACT_UNREAD"]);

// Our own compositor, in the two shapes that were too small for a QR before.
const stamp = await qrOnly(await QRCode.toBuffer(PAYLOAD, { width: 600, margin: 2 }));
const photo = await backdrop(1600, 1200, "blue");
for (const [name, w, h] of [["feed", 1080, 1080], ["display banner", 1200, 628], ["hoarding", 3000, 1000]] as const) {
  const f = await renderFrame({
    w, h, picture: photo, isRender: true, lockup: stamp, logo: null, colour: "#1b3a86",
    registrationNo: REG, phone: "+91 98765 00000", website: "https://sathheights.example", disclaimer: "Prices valid for 30 days.",
    slide: { role: "cover", title: "Sea facing homes", sub: "Eight minutes from the station.", cta: "Book a site visit", facts: { location: "Goregaon West", prices: ["2 BHK starting at ₹2.19 Cr*"] } },
  });
  const bytes = await flatten(f);
  writeFileSync(join(DIR, `stamped-${w}x${h}.jpg`), bytes);
  check(`the compositor's own ${name} passes`, codes(await checkFrame(bytes, expect)), []);
}

// ---------------------------------------------------------------------------
console.log("\na video, read at the first, middle and last of every shot");

const shotsDir = join(DIR, "shots");
execFileSync("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(shotsDir)})`]);
const bare = await frame({ w: 1080, h: 1920, block: null, foot: null, headline: { text: "Ghar jahan samundar dikhe" } });
writeFileSync(join(shotsDir, "a.jpg"), reelFrame);
writeFileSync(join(shotsDir, "b.jpg"), bare);
const ff = process.env.FFMPEG_PATH || "ffmpeg";
const clip = (still: string, out: string) =>
  execFileSync(ff, ["-y", "-loglevel", "error", "-loop", "1", "-i", join(shotsDir, still), "-t", "2", "-r", "24", "-pix_fmt", "yuv420p", "-c:v", "libx264", join(shotsDir, out)]);
clip("a.jpg", "a.mp4");
clip("b.jpg", "b.mp4");
const join2 = (files: string[], out: string) => {
  writeFileSync(join(shotsDir, "list.txt"), files.map((f) => `file '${join(shotsDir, f).replace(/\\/g, "/")}'`).join("\n"));
  execFileSync(ff, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(shotsDir, "list.txt"), "-c", "copy", join(shotsDir, out)]);
  return readFileSync(join(shotsDir, out));
};
const shots = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
check("the moments read are inside each shot, clear of its cuts", sampleTimes(shots), [0.3, 1, 1.7, 2.3, 3, 3.7]);
const whole = join2(["a.mp4", "a.mp4"], "good.mp4");
const videoExpect = { ...expect, contact: false, render: false };
const okVideo = await gatePost({ files: [{ bytes: whole, type: "video/mp4" }], expect: () => videoExpect, times: () => sampleTimes(shots), registrationNo: REG });
check("a video with the block on every frame passes", [okVideo.verdict, okVideo.files[0].frames], ["PASS", 6]);
check("and the record names the file by its hash", okVideo.files[0].sha256, sha256(whole));
const gap = join2(["a.mp4", "b.mp4"], "gap.mp4");
const badVideo = await gatePost({ files: [{ bytes: gap, type: "video/mp4" }], expect: () => videoExpect, times: () => sampleTimes(shots), registrationNo: REG });
check("a shot without the block fails the video", badVideo.verdict, "FAIL");
check("and says when", badVideo.findings.every((f) => (f.at ?? 0) >= 2), true);

// ---------------------------------------------------------------------------
console.log("\nthe approved picture, unchanged");

const approved = await frame(GOOD);
const cobranded = await stampPartner(approved, { firm: "Keystone Realty", agentNo: "A51800012345", code: "SH-KER-4417" });
check("a partner's band beneath the post leaves the post as it was", regionChanged(await compareRegion(cobranded, approved, null)), false);
const painted = await sharp(cobranded).composite([{ input: await sharp({ create: { width: 300, height: 300, channels: 3, background: "#ff8800" } }).png().toBuffer(), left: 300, top: 300 }]).jpeg().toBuffer();
check("a copy whose picture was painted over is caught", regionChanged(await compareRegion(painted, approved, null)), true);
const region = await checkFrame(painted, expect, { region: { expected: approved } });
check("and fails the gate as a changed render", codes(region).includes("RENDER_CHANGED"), true);

// ---------------------------------------------------------------------------
console.log("\nat the moment of publishing");

const record = await gatePost({ files: [{ bytes: approved, type: "image/jpeg" }], expect: () => expect, registrationNo: REG });
const media = [{ sha256: record.files[0].sha256 }];
check("a PASS on these files, under this registration, publishes", pixelRefusal(record, media, REG), null);
check("a file changed since is refused", pixelRefusal(record, [{ sha256: "0".repeat(64) }], REG)?.code, "PIXEL_STALE");
check("another registration today is refused", pixelRefusal(record, media, "P52100099999")?.code, "PIXEL_OTHER_REGISTRATION");
check("a post never checked is refused", pixelRefusal(null, media, REG)?.code, "PIXEL_UNCHECKED");
const held = await gatePost({ files: [{ bytes: approved, type: "image/jpeg" }], expect: () => ({ ...expect, registrationDaysLeft: 10 }), registrationNo: REG });
check("a HOLD is refused", pixelRefusal(held, media, REG)?.code, "PIXEL_HOLD");

console.log(`\n  fixtures in ${DIR}`);
await stopOcr();
if (!fail) rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
