/**
 * A developer's bank tie-ups: the banks its buyers are introduced to, what
 * each offers them and until when, and the projects each has approved.
 *
 * One list feeds three things: the WhatsApp question that asks a buyer
 * whether a bank may call, what the calling agents say about home loans,
 * and the bank a loan file is with. Sales Desk takes nothing from any bank
 * (decided 13 October 2026).
 *
 * Pure, client-safe, covered by `check:logic`. `banks.ts` reads and writes.
 */

import { readRate } from "./loan-rules.ts";

export type BankInput = {
  name: string;
  email: string;
  contactName: string | null;
  contactPhone: string | null;
  rateBp: number | null;
  feeNote: string | null;
  validUntil: string | null;
  /** The projects it approved, each with its approval number when it gave one. */
  projects: { projectId: string; apfNo: string | null }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An Indian number in E.164, or nothing. The same rule the brand kit uses, kept here so a form may import it. */
export function bankPhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const local = digits.startsWith("91") && digits.length > 10 ? digits.slice(2) : digits;
  const trimmed = local.replace(/^0+/, "");
  return trimmed.length === 10 ? `+91${trimmed}` : null;
}

/** "+91 98765 43210" from E.164, for reading. */
export function showBankPhone(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^[+]91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

const text = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
};

/**
 * The bank form, read. `projectIds` are what was ticked and `apf` maps a
 * project to its approval number; a project id that is not an id is dropped
 * here and one that is not the organisation's is refused by the database.
 * Every problem is named in the form's own words.
 */
export function readBankForm(f: {
  name?: unknown;
  email?: unknown;
  contactName?: unknown;
  contactPhone?: unknown;
  rate?: unknown;
  feeNote?: unknown;
  validUntil?: unknown;
  projectIds?: unknown[];
  apf?: Record<string, unknown>;
}, today: string): BankInput | { error: string } {
  const name = text(f.name, 81);
  if (!name) return { error: "Bank: name the bank." };
  if (name.length > 80) return { error: "Bank: keep the name under 80 letters." };
  const email = String(f.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return { error: "Email: where should buyers who say yes be sent? Write it as loans@bank.example." };
  const phoneRaw = String(f.contactPhone ?? "").trim();
  const contactPhone = phoneRaw ? bankPhone(phoneRaw) : null;
  if (phoneRaw && !contactPhone) return { error: `Phone: ${phoneRaw} is not a 10-digit Indian number.` };
  const rateRaw = String(f.rate ?? "").trim();
  const rateBp = rateRaw ? readRate(rateRaw) : null;
  if (rateRaw && rateBp === null) return { error: `Rate: ${rateRaw} is not a rate. Write it as 8.35.` };
  const until = String(f.validUntil ?? "").trim();
  if (until && !YMD.test(until)) return { error: "Valid until: choose a day." };
  if (until && until < today) return { error: "Valid until: that day has passed." };
  const seen = new Set<string>();
  const projects: BankInput["projects"] = [];
  for (const raw of f.projectIds ?? []) {
    const id = String(raw);
    if (!UUID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const apfNo = text(f.apf?.[id], 61);
    if (apfNo && apfNo.length > 60) return { error: "Approval number: keep it under 60 letters." };
    projects.push({ projectId: id, apfNo });
  }
  return {
    name,
    email,
    contactName: text(f.contactName, 80),
    contactPhone,
    rateBp,
    feeNote: text(f.feeNote, 120),
    validUntil: until || null,
    projects: projects.slice(0, 200),
  };
}

/** Within this many days of its last day, a tie-up is ending. */
export const TIE_UP_WARN_DAYS = 30;

/** Whether a tie-up is on, ending, or over. */
export function tieUpState(validUntil: string | null, today: string): "LIVE" | "ENDING" | "ENDED" {
  if (!validUntil) return "LIVE";
  if (validUntil < today) return "ENDED";
  const days = Math.round((Date.parse(`${validUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days <= TIE_UP_WARN_DAYS ? "ENDING" : "LIVE";
}

/**
 * What a calling agent may say about one bank: its name, that it approved
 * this project, and the rate it offers from, when recorded and the tie-up
 * still runs. Never the fee: a fee said on a call is a promise nobody can
 * hold the bank to.
 */
export function tieUpLine(b: { name: string; rateBp: number | null; approved: boolean; validUntil: string | null }, today: string): string | null {
  if (tieUpState(b.validUntil, today) === "ENDED") return null;
  const bits: string[] = [];
  if (b.approved) bits.push("has approved this project");
  if (b.rateBp) bits.push(`rates from ${(b.rateBp / 100).toFixed(2).replace(/\.?0+$/, "")}% a year for our buyers`);
  return bits.length ? `${b.name} (${bits.join(", ")})` : b.name;
}

/**
 * Which banks a buyer at a project is introduced to: those that approved
 * the project first, then those tied to no project at all (an
 * organisation-wide tie-up). A bank tied only to other projects is never
 * offered, and nor is one whose tie-up has ended.
 */
export function banksForProject<T extends { approvedHere: boolean; tiedAnywhere: boolean; validUntil: string | null }>(banks: T[], today: string): T[] {
  const live = banks.filter((b) => tieUpState(b.validUntil, today) !== "ENDED");
  return [...live.filter((b) => b.approvedHere), ...live.filter((b) => !b.approvedHere && !b.tiedAnywhere)];
}
