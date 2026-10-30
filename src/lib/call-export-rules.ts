/**
 * The call log as a file: exactly the calls on screen after the filters, one
 * row each, as CSV or Excel.
 *
 * It follows the masking policy the screen does, because the rows are the
 * screen's own: a number shown masked is masked in the file. The recording
 * is a link to our console, never a storage address: a buyer's voice behind
 * a link anybody holding it can open would undo the sign-in and the
 * permission check every other read passes. Pure, covered by `check:logic`.
 */

import { csvCell } from "./lead-export-rules.ts";
import {
  agentLabel,
  durationLabel,
  GOAL_STATUS,
  istDate,
  istTime,
  LANGUAGE_LABEL,
  nextLabel,
  verdictOf,
  type CallRecord,
} from "./call-rules.ts";
import type { XlsxCell } from "./xlsx-write.ts";

/** The most calls one export carries: what the call log loads at once. */
export const MAX_CALL_EXPORT = 1000;

export type CallExportFormat = "csv" | "xlsx";

const FIXED = [
  "Date",
  "Time",
  "Lead",
  "Phone",
  "Tower",
  "Agent",
  "Outcome",
  "Length",
  "Seconds talked",
  "Attempt",
  "Language",
  "Lead temperature",
  "Next step",
  "Goal",
  "Goal result",
  "Summary",
] as const;

const TEMP = { HOT: "Hot", WARM: "Warm", COLD: "Cold" } as const;

/** The fact columns, in the order they first appear across the calls. */
function factLabels(calls: readonly CallRecord[]): string[] {
  const seen: string[] = [];
  for (const c of calls) for (const f of c.facts) if (!seen.includes(f.label)) seen.push(f.label);
  return seen;
}

/**
 * The header and the rows. `origin` makes each recording's console address
 * whole (`https://app.salesdesk.app/api/calls/<id>/recording?download=1`),
 * which opens for somebody signed in who may read that lead.
 */
export function callExportTable(
  calls: readonly CallRecord[],
  opts: { today: string; nowIso: string; origin: string },
): { header: string[]; rows: XlsxCell[][] } {
  const facts = factLabels(calls);
  const header = [...FIXED, ...facts, "Recording"];
  const rows = calls.map((c): XlsxCell[] => {
    const talked = Math.round(c.duration ?? 0);
    const goalStatus = c.goal?.status ? GOAL_STATUS[c.goal.status].label : "";
    const recording = c.recordingUrl ? `${opts.origin.replace(/\/$/, "")}${c.recordingUrl}?download=1` : null;
    return [
      istDate(c.startedAt),
      istTime(c.startedAt),
      c.leadName,
      c.phone.text,
      c.place,
      agentLabel(c.agent),
      verdictOf(c)?.label ?? c.outcome,
      c.duration === null ? "" : durationLabel(c.duration),
      talked,
      c.attempt,
      LANGUAGE_LABEL[c.language] ?? c.language,
      c.temp ? TEMP[c.temp] : "",
      nextLabel(c, opts.today, opts.nowIso).text,
      c.goal?.text ?? "",
      [goalStatus, c.goal?.note ?? ""].filter(Boolean).join(": "),
      c.summary ?? "",
      ...facts.map((label) => c.facts.find((f) => f.label === label)?.value ?? ""),
      recording ? { text: "Play recording", link: recording } : "",
    ];
  });
  return { header, rows };
}

/** The table as CSV, with a byte-order mark so Excel reads the rupee and Devanagari right. */
export function callsCsv(table: { header: string[]; rows: XlsxCell[][] }): string {
  const text = (v: XlsxCell) => (v === null ? "" : typeof v === "object" ? v.link : String(v));
  const lines = [table.header, ...table.rows.map((r) => r.map(text))];
  return "﻿" + lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Column widths for the sheet, in characters. */
export function callExportWidths(header: readonly string[]): number[] {
  const wide: Record<string, number> = { Lead: 22, Phone: 16, Tower: 24, "Next step": 30, Goal: 36, "Goal result": 30, Summary: 60, Recording: 16 };
  return header.map((h) => wide[h] ?? Math.max(10, h.length + 2));
}

/** The calls asked for, in the order asked, kept to those this person may export. */
export function pickCalls(all: readonly CallRecord[], ids: readonly string[]): CallRecord[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: CallRecord[] = [];
  const seen = new Set<string>();
  for (const id of ids.slice(0, MAX_CALL_EXPORT)) {
    const c = byId.get(id);
    if (c && !seen.has(id)) {
      seen.add(id);
      out.push(c);
    }
  }
  return out;
}

/** The ids the form posted: a JSON list of short strings, nothing else. */
export function readIds(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length > 200_000) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80).slice(0, MAX_CALL_EXPORT) : [];
  } catch {
    return [];
  }
}

/** What the file carried, for the audit row: counts, never contents. */
export function callExportTally(calls: readonly CallRecord[], format: CallExportFormat) {
  return {
    format,
    rows: calls.length,
    full: calls.filter((c) => c.phone.state === "FULL").length,
    masked: calls.filter((c) => c.phone.state === "MASKED").length,
    hidden: calls.filter((c) => c.phone.state === "HIDDEN").length,
    recordings: calls.filter((c) => c.recordingUrl).length,
  };
}
