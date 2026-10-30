/**
 * The leads file: what a row says, and how it is written so a spreadsheet
 * reads it as data.
 *
 * Export is the obvious way around masking, so it follows the same policy
 * row by row: a number the person sees masked on screen is masked in the
 * file, and a hidden one is an empty cell. Pure, covered by `check:logic`.
 */

import type { Shown } from "./mask-rules.ts";

export type ExportRow = {
  name: string;
  phone: Shown;
  email: Shown;
  stage: string;
  place: string;
  source: string;
  /** IST civil date. */
  enquiredOn: string;
};

/** More than this in one file is a data migration, not an export. */
export const MAX_EXPORT_ROWS = 20_000;

const HEADER = ["Name", "Phone", "Email", "Stage", "Tower", "Source", "Enquired on"];

/**
 * One cell. Quoted when it must be, and a leading `=`, `+`, `-` or `@` is
 * made literal, because a buyer's name typed as a formula runs as one the
 * moment the file is opened.
 */
export function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The whole file, with a byte-order mark so Excel reads the rupee and Devanagari right. */
export function leadsCsv(rows: readonly ExportRow[]): string {
  const lines = [HEADER, ...rows.map((r) => [r.name, r.phone.text, r.email.text, r.stage, r.place, r.source, r.enquiredOn])];
  return "﻿" + lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** What the file carried, for the audit row: counts, never contents. */
export function exportTally(rows: readonly ExportRow[]): { rows: number; full: number; masked: number; hidden: number } {
  return {
    rows: rows.length,
    full: rows.filter((r) => r.phone.state === "FULL").length,
    masked: rows.filter((r) => r.phone.state === "MASKED").length,
    hidden: rows.filter((r) => r.phone.state === "HIDDEN").length,
  };
}
