import { join } from "node:path";
import sharp from "sharp";
import { partnerStrip } from "./partner-rules.ts";

/**
 * A channel partner's copy of an approved post: the post untouched, with a
 * dark band added beneath it naming the firm, its MahaRERA agent number and
 * the ref code. The band is added, never laid over, so nothing the post
 * carries (the registration block, the small print) is covered. No model is
 * called; it is a few milliseconds of our own CPU.
 */

const FONTS = join(process.cwd(), "assets", "fonts");

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function line(text: string, bold: boolean, size: number, width: number, color: string) {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${color}">${escape(text)}</span>`,
      fontfile: join(FONTS, bold ? "NotoSans-Bold.ttf" : "NotoSans-Regular.ttf"),
      font: `Noto Sans ${bold ? "Bold " : ""}${size}`,
      width: Math.max(10, Math.round(width)),
      rgba: true,
      wrap: "word",
      dpi: 72,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

export async function stampPartner(bytes: Buffer, o: { firm: string; agentNo: string; code: string }): Promise<Buffer> {
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 1080;
  const H = meta.height ?? 1080;
  const pad = Math.round(Math.min(W, H) * 0.04);
  const big = Math.max(14, Math.round(Math.min(W, H) * 0.03));
  const small = Math.max(12, Math.round(big * 0.8));
  const [first, second] = partnerStrip(o.firm, o.agentNo, o.code);
  const a = await line(first, true, big, W - pad * 2, "#ffffff");
  const b = await line(second, false, small, W - pad * 2, "#d9dce3");
  const gap = Math.round(big * 0.35);
  const band = pad + a.h + gap + b.h + pad;
  return sharp(bytes)
    .extend({ bottom: band, background: "#15171c" })
    .composite([
      { input: a.data, left: pad, top: H + pad },
      { input: b.data, left: pad, top: H + pad + a.h + gap },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}
