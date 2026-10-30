// Assemble the product flow's section fragments into a print-ready HTML
// document, in the Seed Plan's look, and render it to PDF with headless Chrome.
//
//   node scripts/build-doc.mjs <sections.json> <out.pdf>
//   python scripts/stamp-pdf.py <out.pdf>          # ground, footers, page numbers
//
// The JSON is { order, titles, headlines, sections, date, version }. A
// headline may mark one word or phrase as *emphasis*: it is set in the
// italic serif, the Seed Plan's signature, so use it once per heading.
//
// The contents on the cover carry page numbers. They are found by rendering
// once, asking stamp-pdf.py where each section's kicker landed, and rendering
// again with those numbers (twice at most, since the numbers do not move
// anything else).
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const [, , sectionsPath, outPath] = process.argv;
if (!sectionsPath || !outPath) {
  console.error("usage: node scripts/build-doc.mjs <sections.json> <out.pdf>");
  process.exit(1);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("No Chrome or Edge found for PDF rendering.");
  process.exit(1);
}

const data = JSON.parse(await readFile(sectionsPath, "utf8"));
const byId = new Map(data.sections.map((s) => [s.id, s]));
const ordered = data.order.map((id) => byId.get(id)).filter(Boolean);

const DATE = data.date ?? "3 October 2026";
const MONTH = DATE.replace(/^\d+\s+/, "");
const VERSION = data.version ?? "v2.0";

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "From an ad click *to a booking*" with the starred part in the serif. */
const headline = (s) =>
  escapeHtml(s).replace(/\*([^*]+)\*/g, '<em class="s">$1</em>');

const num = (i) => String(i + 1).padStart(2, "0");
const titleOf = (s) => data.titles[s.id] ?? s.id;
/** Upper case in the source, not by CSS, so the PDF's text says it too. */
const kickerOf = (s, i) => `${num(i)} · ${titleOf(s)}`.toUpperCase();

function page(pages) {
  const toc = ordered
    .map(
      (s, i) =>
        `<li><span>${num(i)} · ${escapeHtml(titleOf(s))}</span>` +
        `<span class="muted">${pages[s.id] ?? ""}</span></li>`,
    )
    .join("\n");

  const body = ordered
    .map(
      (s, i) => `<section class="sec">
<span class="kicker">${escapeHtml(kickerOf(s, i))}</span>
<h2>${headline(data.headlines?.[s.id] ?? titleOf(s))}</h2>
<p class="lede">${escapeHtml(s.summary ?? "")}</p>
${s.html}
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sales Desk Product Flow</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&display=block" rel="stylesheet">
<style>
  @page { size: A4; margin: 15mm 15mm 19mm; }
  @page :first { margin: 0; }

  :root {
    --ground: #f4f4f1; --card: #ffffff; --ink: #121318; --muted: #5d606b; --line: #e3e3de;
    --blue: #2f5bea; --blue-soft: #e8eefe; --green: #1f9d6b; --green-soft: #e3f5ec;
    --pink: #e0457b; --pink-soft: #fde8ef; --amber: #c98a12; --amber-soft: #fbf1dc;
    --dark: #15161b;
  }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: var(--ground); }
  body {
    margin: 0; font-family: "Segoe UI", system-ui, sans-serif; font-size: 9.4pt;
    line-height: 1.5; color: var(--ink); background: var(--ground);
  }
  em.s { font-family: "Instrument Serif", Georgia, serif; font-style: italic; font-weight: 400; letter-spacing: 0; }
  .muted { color: var(--muted); }

  /* ---------- cover ---------- */
  .cover {
    height: 297mm; padding: 15mm 15mm 17mm; overflow: hidden;
    display: flex; flex-direction: column; justify-content: space-between;
    break-after: page;
  }
  .logo { display: flex; align-items: center; gap: 2.5mm; font-weight: 600; font-size: 12pt; }
  .logo .mk {
    width: 9mm; height: 9mm; border-radius: 8px; background: var(--blue); color: #fff;
    display: flex; align-items: center; justify-content: center; font-weight: 700;
  }
  .cover h1 { font-size: 40pt; font-weight: 600; line-height: 1.04; letter-spacing: -0.035em; margin: 0; }
  .cover h1 em.s { font-size: 46pt; }
  .cover .lede { margin-top: 5mm; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4mm; margin-top: 7mm; }
  .stat .n { font-size: 20pt; font-weight: 600; letter-spacing: -0.03em; line-height: 1.1; }
  .stat .l { font-size: 8.2pt; color: var(--muted); margin-top: 1mm; }
  .card {
    background: var(--card); border-radius: 16px; padding: 5mm 5.5mm;
    box-shadow: 0 1px 2px rgba(20,20,30,.04), 0 6px 18px rgba(20,20,30,.05);
  }
  .card.dark { background: var(--dark); color: #f2f2f4; }
  .card.dark .l { color: #a5a7b2; }
  .toc { padding: 0; margin: 0; }
  .toc li {
    display: flex; justify-content: space-between; border-bottom: 1px solid var(--line);
    padding: 1.6mm 0; list-style: none;
  }
  .byline { font-size: 8.2pt; color: var(--muted); margin-top: 4mm; }

  /* ---------- sections ----------
     Each section opens a page with its kicker and headline, as the Seed Plan
     does; inside a section the content flows, because this is a reference to
     look things up in and most sections run to several pages. */
  .sec { break-before: page; }
  .kicker {
    display: inline-block; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.12em;
    color: var(--blue); margin-bottom: 2mm;
  }
  h2 {
    font-size: 21pt; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em;
    margin: 0 0 3mm; break-after: avoid;
  }
  h2 em.s { font-size: 24pt; }
  .lede { font-size: 11pt; color: #33353d; max-width: 165mm; margin: 0 0 6mm; }
  h3 {
    font-size: 11.5pt; font-weight: 600; letter-spacing: -0.01em; margin: 7mm 0 2.5mm;
    break-after: avoid;
  }
  h4 { font-size: 9.6pt; font-weight: 600; margin: 5mm 0 1.8mm; break-after: avoid; }
  p { margin: 0 0 2.8mm; }
  ul, ol { margin: 0 0 3.5mm; padding-left: 5mm; }
  li { margin-bottom: 1.3mm; }
  strong { font-weight: 600; }
  code {
    font-family: "Cascadia Mono", Consolas, monospace; font-size: 8.1pt;
    background: #ebebe6; border-radius: 4px; padding: 0 1.4pt;
  }

  /* ---------- diagrams: the column takes 68 characters a line ---------- */
  pre.diagram {
    font-family: "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace;
    font-size: 7.4pt; line-height: 1.32; white-space: pre; overflow: hidden;
    background: var(--card); border-radius: 14px; padding: 4mm 5mm;
    margin: 3.5mm 0 4.5mm; break-inside: avoid;
    box-shadow: 0 1px 2px rgba(20,20,30,.04), 0 6px 18px rgba(20,20,30,.05);
  }

  /* ---------- tables ---------- */
  table {
    width: 100%; border-collapse: separate; border-spacing: 0; margin: 3mm 0 4.5mm;
    font-size: 8.5pt; background: var(--card); border-radius: 14px; overflow: hidden;
    box-shadow: 0 1px 2px rgba(20,20,30,.04), 0 6px 18px rgba(20,20,30,.05);
  }
  th {
    text-align: left; font-weight: 600; font-size: 7.4pt; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted); padding: 2.4mm 3mm 1.8mm;
    border-bottom: 1px solid var(--line);
  }
  td { padding: 1.9mm 3mm; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr { break-inside: avoid; }

  /* ---------- callouts and status ---------- */
  .callout {
    background: linear-gradient(120deg, #e6ecff 0%, #f6e7f4 45%, #efe9ff 70%, #fdeee2 100%);
    border-radius: 14px; padding: 4mm 5mm; margin: 3.5mm 0 4.5mm; font-size: 9pt;
    break-inside: avoid;
  }
  .pill {
    display: inline-block; font-size: 7.2pt; font-weight: 600; padding: 0.5mm 2.4mm;
    border-radius: 99px; background: var(--blue-soft); color: var(--blue); white-space: nowrap;
  }
  .pill.g { background: var(--green-soft); color: var(--green); }
  .pill.p { background: var(--pink-soft); color: var(--pink); }
  .pill.a { background: var(--amber-soft); color: var(--amber); }
  .status {
    font-size: 8.2pt; font-weight: 600; padding: 2mm 3.5mm; border-radius: 10px;
    margin: 0 0 4mm; break-inside: avoid;
  }
  .status--built { background: var(--green-soft); color: var(--green); }
  .status--planned { background: var(--amber-soft); color: var(--amber); }
</style>
</head>
<body>

<section class="cover">
  <div class="logo"><span class="mk">E</span>Sales Desk</div>
  <div>
    <span class="kicker">PRODUCT FLOW · ${escapeHtml(MONTH.toUpperCase())} · INTERNAL</span>
    <h1>From an ad click<br>to <em class="s">a booking</em></h1>
    <p class="lede">How a lead travels from an ad to a booking and back to the ad
    platform, and the tenancy, compliance, creative and channel-partner machinery
    underneath it: what each part does, how it is built, and what is still to come.</p>
    <div class="stats">
      <div class="card stat"><div class="n">9 states</div><div class="l">RERA registrations checked against the authority's own register</div></div>
      <div class="card stat"><div class="n">81</div><div class="l">Database migrations, every tenant table under row-level security</div></div>
      <div class="card dark stat"><div class="n">Not live</div><div class="l">Built and proven with every vendor stood in for; no paying client yet</div></div>
    </div>
  </div>
  <div>
    <ol class="toc">
${toc}
    </ol>
    <p class="byline">${escapeHtml(VERSION)} · ${escapeHtml(DATE)} · Indian primary residential · salesdesk.app</p>
  </div>
</section>

${body}

</body>
</html>`;
}

const htmlPath = resolve(join(dirname(outPath), "salesdesk-flow.html"));
const pdfPath = resolve(outPath);

async function render(pages) {
  await writeFile(htmlPath, page(pages), "utf8");
  await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    // Time for the serif to arrive from Google Fonts before printing.
    "--virtual-time-budget=15000",
    `--print-to-pdf=${pdfPath}`,
    "file:///" + htmlPath.replace(/\\/g, "/"),
  ]);
}

async function locate() {
  const kickers = Object.fromEntries(ordered.map((s, i) => [s.id, kickerOf(s, i)]));
  const { stdout } = await run("python", [
    join(here, "stamp-pdf.py"),
    "--locate",
    pdfPath,
    JSON.stringify(kickers),
  ]);
  return JSON.parse(stdout);
}

let pages = {};
for (let pass = 0; pass < 3; pass++) {
  await render(pages);
  const found = await locate();
  if (ordered.every((s) => found[s.id] === pages[s.id])) break;
  pages = found;
}
console.log(`rendered ${pdfPath}`);
