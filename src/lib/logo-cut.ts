import sharp from "sharp";

/**
 * A logo lifted off the page it was printed on, and the versions a brand kit
 * holds made from it (the client, 30 October 2026): a brochure's logo comes
 * out of the PDF on the cover's own background (SAMPLE's on a textured grey),
 * and set on a post that grey came with it. All of it is arithmetic on the
 * logo's own pixels; nothing is redrawn, so the mark is the developer's own.
 *
 * - `cutOutLogo()`: the background taken out. Its colour is read off the
 *   border, how much the border varies (a texture) sets how close a pixel
 *   must be to count as background, and every such pixel goes, inside the
 *   letters too, with a soft edge. A colour the logo shares with its own
 *   background already reads as background on the page, so nothing a reader
 *   saw is lost. Specks of texture left over are dropped and the result cut
 *   to what is drawn. A logo that came with transparency is only cut.
 * - `whiteLogo()`: every drawn pixel white, its edge kept: the single-colour
 *   mark for a dark picture.
 * - `horizontalLogo()`: a stacked logo (a mark above a name) laid out side
 *   by side, when an empty band of rows parts the two; otherwise none.
 * - `logoColours()`: the brand colour (the strongest hue it is drawn in) and
 *   the accent (its dark ink), as hex.
 */

type Raw = { data: Buffer; w: number; h: number };

async function raw(bytes: Buffer): Promise<Raw> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

const png = (r: Raw) => sharp(r.data, { raw: { width: r.w, height: r.h, channels: 4 } }).png().toBuffer();

/** The median of numbers. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** The smallest box holding every pixel more than half drawn, or null when nothing is. */
function drawnBox(r: Raw): { x: number; y: number; w: number; h: number } | null {
  let [x0, y0, x1, y1] = [r.w, r.h, -1, -1];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (r.data[(y * r.w + x) * 4 + 3] > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function cut(r: Raw, pad = 0): Promise<Raw> {
  const b = drawnBox(r);
  if (!b) return r;
  const left = Math.max(0, b.x - pad);
  const top = Math.max(0, b.y - pad);
  const width = Math.min(r.w - left, b.w + pad * 2);
  const height = Math.min(r.h - top, b.h + pad * 2);
  const { data, info } = await sharp(r.data, { raw: { width: r.w, height: r.h, channels: 4 } })
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** Drop drawn pieces smaller than `min` pixels: specks of texture, never a letter. */
function dropSpecks(r: Raw, min: number): void {
  const n = r.w * r.h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s] || r.data[s * 4 + 3] <= 64) continue;
    let top = 0;
    let size = 0;
    const members: number[] = [];
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top];
      size++;
      if (size <= min) members.push(i);
      const x = i % r.w;
      const y = (i - x) / r.w;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= r.w || ny >= r.h) continue;
        const j = ny * r.w + nx;
        if (!seen[j] && r.data[j * 4 + 3] > 64) {
          seen[j] = 1;
          stack[top++] = j;
        }
      }
    }
    if (size < min) for (const i of members) r.data[i * 4 + 3] = 0;
  }
}

export type CutLogo = { png: Buffer; width: number; height: number; cut: boolean };

/** The logo with its background taken out and cut to what is drawn. */
export async function cutOutLogo(bytes: Buffer): Promise<CutLogo> {
  const r = await raw(bytes);
  const px = r.w * r.h;
  let clear = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] < 16) clear++;
  let keyed = false;
  if (clear < px * 0.02) {
    const edge: number[] = [];
    const step = Math.max(1, Math.floor((r.w + r.h) / 1500));
    for (let x = 0; x < r.w; x += step) edge.push(x, (r.h - 1) * r.w + x);
    for (let y = 0; y < r.h; y += step) edge.push(y * r.w, y * r.w + r.w - 1);
    const bg = [0, 1, 2].map((c) => median(edge.map((i) => r.data[i * 4 + c])));
    const dist = (i: number) => Math.hypot(r.data[i * 4] - bg[0], r.data[i * 4 + 1] - bg[1], r.data[i * 4 + 2] - bg[2]);
    // The border's own texture, read off the nearer two thirds of it: a logo
    // cut tight runs into the border here and there, and those pixels are not
    // the background's variation.
    const spread = edge.map(dist).sort((a, b) => a - b);
    const p66 = spread[Math.floor(spread.length * 0.66)] ?? 0;
    const lo = Math.min(70, Math.max(22, p66 * 2));
    // A border that is mostly the logo itself (a full-bleed mark) is left alone.
    if (spread.filter((d) => d <= lo).length >= spread.length * 0.55) {
      const hi = lo * 1.7;
      for (let i = 0; i < px; i++) {
        const d = dist(i);
        const a = d <= lo ? 0 : d >= hi ? 255 : Math.round(((d - lo) / (hi - lo)) * 255);
        r.data[i * 4 + 3] = Math.min(r.data[i * 4 + 3], a);
      }
      dropSpecks(r, Math.max(6, Math.round(px * 0.00003)));
      keyed = true;
    }
  }
  const out = await cut(r);
  const max = 2000;
  let bytesOut = await png(out);
  let { w, h } = out;
  if (Math.max(w, h) > max) {
    const s = await sharp(bytesOut).resize({ width: max, height: max, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    bytesOut = s.data;
    w = s.info.width;
    h = s.info.height;
  }
  return { png: bytesOut, width: w, height: h, cut: keyed };
}

/** Every drawn pixel white, its soft edge kept. */
export async function whiteLogo(cutPng: Buffer): Promise<Buffer> {
  const r = await raw(cutPng);
  for (let i = 0; i < r.data.length; i += 4) {
    r.data[i] = 255;
    r.data[i + 1] = 255;
    r.data[i + 2] = 255;
  }
  return png(r);
}

/**
 * A stacked logo laid out side by side: the mark on the left at the name's
 * height and a little more, the name to its right, centred. Only when an
 * empty band of rows parts a mark above from a name below, both of real
 * size; anything else is not a stacked logo this can read, and gives none.
 */
export async function horizontalLogo(cutPng: Buffer): Promise<Buffer | null> {
  const r = await raw(cutPng);
  const filled = (y: number) => {
    let n = 0;
    for (let x = 0; x < r.w; x++) if (r.data[(y * r.w + x) * 4 + 3] > 64) n++;
    return n;
  };
  const rows = Array.from({ length: r.h }, (_, y) => filled(y) > Math.max(1, r.w * 0.002));
  // The widest empty band of rows inside the drawing.
  let best = { at: -1, size: 0 };
  let run = 0;
  for (let y = 0; y < r.h; y++) {
    if (!rows[y]) run++;
    else {
      if (run > best.size && y - run > 0) best = { at: y - run, size: run };
      run = 0;
    }
  }
  if (best.at < 0 || best.size < r.h * 0.02) return null;
  const markH = best.at;
  const nameTop = best.at + best.size;
  const nameH = r.h - nameTop;
  if (markH < r.h * 0.25 || nameH < r.h * 0.1) return null;
  const part = async (top: number, height: number) => {
    const { data, info } = await sharp(r.data, { raw: { width: r.w, height: r.h, channels: 4 } })
      .extract({ left: 0, top, width: r.w, height })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return cut({ data, w: info.width, h: info.height });
  };
  const mark = await part(0, markH);
  const name = await part(nameTop, nameH);
  const targetMarkH = Math.round(name.h * 1.25);
  const scale = targetMarkH / mark.h;
  const markW = Math.max(1, Math.round(mark.w * scale));
  const markBuf = await sharp(await png(mark)).resize({ width: markW, height: targetMarkH, fit: "fill" }).png().toBuffer();
  const gap = Math.round(targetMarkH * 0.3);
  const W = markW + gap + name.w;
  const H = Math.max(targetMarkH, name.h);
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: markBuf, left: 0, top: Math.round((H - targetMarkH) / 2) },
      { input: await png(name), left: markW + gap, top: Math.round((H - name.h) / 2) },
    ])
    .png()
    .toBuffer();
}

const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** The brand colour (the strongest hue drawn) and the accent (its dark ink), or null for either it does not have. */
export async function logoColours(cutPng: Buffer): Promise<{ primary: string | null; accent: string | null }> {
  const { data, info } = await sharp(cutPng).ensureAlpha().resize({ width: 300, height: 300, fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const hued: number[][] = [];
  const dark: number[][] = [];
  let solid = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] < 200) continue;
    solid++;
    const c = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    const max = Math.max(...c);
    const min = Math.min(...c);
    const sat = max ? (max - min) / max : 0;
    if (sat > 0.3 && max > 60) hued.push(c);
    else if (max < 70) dark.push(c);
  }
  const mean = (xs: number[][]) => [0, 1, 2].map((k) => xs.reduce((s, c) => s + c[k], 0) / xs.length);
  return {
    primary: hued.length >= solid * 0.05 && hued.length >= 20 ? hex(mean(hued)) : null,
    accent: dark.length >= solid * 0.05 && dark.length >= 20 ? hex(mean(dark)) : null,
  };
}
