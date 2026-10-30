/**
 * Makes `db/fixtures/extract/marathi-price-list.pdf`, the Devanagari price
 * list `check:extract` reads: a Marathi page set in the bundled Noto Sans
 * Devanagari, printed to PDF by Chromium so the text layer carries the
 * letters (and Devanagari digits) as a developer's word processor would.
 *
 *   node scripts/make-devanagari-fixture.mjs /path/to/chrome
 *
 * Run once; the PDF is committed so the suite needs no browser.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const chrome = process.argv[2] ?? process.env.CHROME_PATH;
if (!chrome) throw new Error("Pass the path to a Chromium binary.");
const font = readFileSync("assets/fonts/NotoSansDevanagari-Regular.ttf").toString("base64");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Dev; src: url(data:font/ttf;base64,${font}); }
body { font-family: Dev; font-size: 14pt; margin: 60px; }
td { padding: 4px 48px 4px 0; }
</style></head><body>
<p style="font-size:20pt">साथ हाइट्स, टॉवर सी</p>
<p>दरपत्रक, १ ऑक्टोबर २०२६ पासून लागू</p>
<p>मूळ दर: रु. १२,५०० प्रति चौरस फूट चटई क्षेत्र</p>
<p>बुकिंग रक्कम: रु. २ लाख</p>
<table>
<tr><td>प्रकार</td><td>चटई क्षेत्र</td><td>किंमत</td></tr>
<tr><td>१ बीएचके</td><td>४५२</td><td>रु. ५६.५ लाख</td></tr>
<tr><td>२ बीएचके</td><td>६८२</td><td>रु. ८५,२५,०००</td></tr>
</table>
<p>ताबा: डिसेंबर २०२८</p>
</body></html>`;

const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync("db/fixtures/extract", { recursive: true });
  writeFileSync("db/fixtures/extract/marathi-price-list.pdf", await page.pdf({ format: "A4", printBackground: true }));
} finally {
  await browser.close();
}
