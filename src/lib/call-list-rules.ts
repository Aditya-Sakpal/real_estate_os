import { CALLING_HOURS, goalProblem, GOAL_MAX, istDate, normalisePhone } from "./calling-rules.ts";
import { guessLanguage } from "./name-language-rules.ts";
import type { Language } from "./call-rules.ts";

/**
 * A call list: a spreadsheet of people a person wants the agent to ring.
 *
 * The pure half. A model reads the header and a random handful of rows and
 * says what each column holds and what the list is for; code checks that
 * (the phone column really holds phone numbers) and falls back on its own
 * reading when the model is wrong or down. Then each row's remarks ("visited
 * in August, liked the 2 BHK", "call after Diwali", "not interested") are
 * read into what the call should do for that person, or why it should not
 * happen at all. Every instruction is a call goal, held to `goalProblem()`:
 * no price, no offer, no number beyond a day and a time.
 */

/** The most people one list may hold. */
export const MAX_LIST_ROWS = 500;
/** Rows the model is shown to understand the columns, picked at random. */
export const SAMPLE_ROWS = 12;
/** Rows whose remarks are read in one request. */
export const ROWS_PER_READ = 40;
/** Requests at once while reading remarks. */
export const READS_AT_ONCE = 4;
/** Lists one organisation may read in an IST day. */
export const LISTS_PER_DAY = 10;
/** What one read counts against the project's AI minutes, as a call's reading does. */
export const LIST_READ_MINUTES = 0.15;
/** One read at worst: about 6,000 tokens in and 3,000 out on `gpt-5-mini`, in paise. */
export const LIST_READ_COST_PAISE = 70;
/** The most calls a list rings at once; the project's own lines (its plan's channels) decide below that. */
export const LIST_MAX_LINES = 10;
/** Tries a person on a list gets when nobody answers, and the wait between them. */
export const LIST_TRIES = 3;
export const LIST_RETRY_MS = 2 * 60 * 60_000;
/** A list nobody started is cleared out after this long. */
export const DRAFT_DAYS = 2;
/** The most a remark may hold, as read. */
export const NOTE_MAX = 600;

export type ColumnMeaning = "name" | "first_name" | "last_name" | "phone" | "alt_phone" | "language" | "project" | "context" | "ignore";
export const MEANINGS: readonly ColumnMeaning[] = ["name", "first_name", "last_name", "phone", "alt_phone", "language", "project", "context", "ignore"];
export const MEANING_LABEL: Record<ColumnMeaning, string> = {
  name: "Name",
  first_name: "First name",
  last_name: "Last name",
  phone: "Phone",
  alt_phone: "Other phone",
  language: "Language",
  project: "Project or tower",
  context: "Read for each person",
  ignore: "Not used",
};

export type Column = { index: number; header: string; meaning: ColumnMeaning; /** How a value in it shapes a call, for a context column. */ use?: string };

export type ListRowState = "READY" | "SKIPPED" | "CALLING" | "CALLED" | "UNREACHED" | "REFUSED";
export const ROW_STATE_LABEL: Record<ListRowState, string> = {
  READY: "To call",
  SKIPPED: "Skipped",
  CALLING: "Calling",
  CALLED: "Spoke",
  UNREACHED: "No answer",
  REFUSED: "Not called",
};

export type ListState = "DRAFT" | "RUNNING" | "PAUSED" | "DONE" | "CANCELLED";
export const LIST_STATE_LABEL: Record<ListState, string> = {
  DRAFT: "Not started",
  RUNNING: "Calling",
  PAUSED: "Paused",
  DONE: "Finished",
  CANCELLED: "Stopped",
};

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const clean = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

/** A phone as a spreadsheet tends to hold it: "9876543210.0", "9.87654321E9", "+91-98765 43210". */
export function phoneOf(cell: string): string | null {
  let v = clean(cell);
  if (!v) return null;
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) v = n.toFixed(0);
  }
  v = v.replace(/\.0+$/, "");
  return normalisePhone(v);
}

const isPhoneish = (cell: string) => phoneOf(cell) !== null;

/**
 * Where the header is: the first of the first five rows that has two or
 * more filled cells and no phone number in it. A title row above the header
 * is common; a sheet with no header at all has its first row of people.
 */
export function headerAt(rows: readonly (readonly string[])[]): number | null {
  for (let i = 0; i < Math.min(5, rows.length); i += 1) {
    const filled = rows[i].map(clean).filter(Boolean);
    if (filled.length < 2) continue;
    if (filled.some(isPhoneish)) return null;
    return i;
  }
  return null;
}

/** The sheet as a header and its rows, blank rows dropped, each row padded to the header. */
export function tableOf(rows: readonly (readonly string[])[]): { header: string[]; body: { line: number; cells: string[] }[] } {
  const at = headerAt(rows);
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  const header = at === null ? Array.from({ length: width }, (_, i) => `Column ${i + 1}`) : rows[at].map((h, i) => clean(h) || `Column ${i + 1}`);
  while (header.length < width) header.push(`Column ${header.length + 1}`);
  const body: { line: number; cells: string[] }[] = [];
  rows.forEach((r, i) => {
    if (at !== null && i <= at) return;
    const cells = header.map((_, c) => clean(r[c]));
    if (cells.some(Boolean)) body.push({ line: i + 1, cells });
  });
  return { header, body };
}

/** A seeded pick of `n` distinct indexes below `count`, so a read retried picks the same rows. */
export function sampleIndexes(count: number, n: number, seed: string): number[] {
  if (count <= n) return Array.from({ length: count }, (_, i) => i);
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const next = () => {
    h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return h / 2 ** 32;
  };
  const picked = new Set<number>();
  while (picked.size < n) picked.add(Math.floor(next() * count));
  return [...picked].sort((a, b) => a - b);
}

/** Digits a model never needs: a phone keeps its shape and loses its middle. */
export function hideDigits(text: string): string {
  return text.replace(/\+?\d[\d\s-]{7,16}\d/g, (run) => {
    const d = run.replace(/\D/g, "");
    return d.length >= 8 ? `${d.slice(0, 2)}${"X".repeat(d.length - 4)}${d.slice(-2)}` : run;
  });
}

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

const HEADER_WORDS: [ColumnMeaning, RegExp][] = [
  ["alt_phone", /\b(alt(ernate)?|other|second|2nd|whats ?app|office|landline)\b.*\b(phone|mobile|number|no|contact)\b|\bphone ?2\b|\bmobile ?2\b/i],
  ["phone", /\b(phone|mobile|mob|cell|contact( no| number)?|number|whats ?app|ph)\b/i],
  ["first_name", /\bfirst ?name\b|\bfname\b|\bgiven name\b/i],
  ["last_name", /\b(last|sur) ?name\b|\blname\b|\bsurname\b/i],
  ["name", /\b(name|customer|client|prospect|buyer|lead|contact person)\b/i],
  ["language", /\b(language|lang|bhasha)\b/i],
  ["project", /\b(project|tower|wing|building|property|site)\b/i],
  ["context", /\b(remark|remarks|note|notes|comment|comments|feedback|status|budget|config|configuration|bhk|requirement|interest|interested|last (call|discussion|visit)|visit|follow ?up|source|stage|disposition|location|area|city|occupation|purpose|timeline|what to say|special|instruction)\b/i],
  ["ignore", /\b(sr|s\.? ?no|serial|id|#|email|e-mail|date|time|created|updated)\b/i],
];

/** What a header alone suggests, or null. */
export function meaningFromHeader(header: string): ColumnMeaning | null {
  for (const [m, re] of HEADER_WORDS) if (re.test(header)) return m;
  return null;
}

/** The share of a column's filled cells that read as a phone number. */
export function phoneShare(values: readonly string[]): number {
  const filled = values.filter((v) => clean(v));
  if (!filled.length) return 0;
  return filled.filter(isPhoneish).length / filled.length;
}

/** The share of a column's filled cells that name a flat size. */
export function sizeShare(values: readonly string[]): number {
  const filled = values.filter((v) => clean(v));
  if (!filled.length) return 0;
  return filled.filter((v) => /\b\d(\.5)?\s*(bhk|rk)\b|\b(studio|penthouse|jodi|villa|plot|shop|office)\b/i.test(v)).length / filled.length;
}

const looksLikeNames = (values: readonly string[]) => {
  const filled = values.filter((v) => clean(v));
  if (!filled.length) return false;
  const named = filled.filter((v) => /^[\p{L}][\p{L} .'-]{1,60}$/u.test(clean(v)) && !/\d/.test(v));
  return named.length / filled.length >= 0.7;
};

/** Our own reading of the columns, from the headers and what the cells hold. Used when the model's is wrong or missing. */
export function guessColumns(header: readonly string[], body: readonly { cells: string[] }[]): Column[] {
  const col = (i: number) => body.map((r) => r.cells[i] ?? "");
  const cols: Column[] = header.map((h, index) => ({ index, header: h, meaning: meaningFromHeader(h) ?? "context" }));
  // The phone is the column that holds phones, whatever it is called.
  const shares = header.map((_, i) => phoneShare(col(i)));
  const named = cols.filter((c) => c.meaning === "phone" && shares[c.index] >= 0.6);
  const best = named.length ? named.sort((a, b) => shares[b.index] - shares[a.index])[0] : cols.filter((c) => shares[c.index] >= 0.6).sort((a, b) => shares[b.index] - shares[a.index])[0];
  for (const c of cols) {
    if (c === best) c.meaning = "phone";
    else if (shares[c.index] >= 0.6) c.meaning = "alt_phone";
    else if (c.meaning === "phone" || c.meaning === "alt_phone") c.meaning = "ignore";
  }
  // A name, if no header said so: the first column of names.
  if (!cols.some((c) => c.meaning === "name" || c.meaning === "first_name")) {
    const n = cols.find((c) => c.meaning === "context" && looksLikeNames(col(c.index)));
    if (n) n.meaning = "name";
  }
  // A context column holding nothing is not read.
  for (const c of cols) if (c.meaning === "context" && !col(c.index).some((v) => clean(v))) c.meaning = "ignore";
  return cols;
}

/**
 * The model's reading of the columns, checked. Its phone column must hold
 * phones in most rows and its name column must not; anything it named that
 * fails is replaced by our own reading of that column. Returns null when no
 * column holds phones, which ends the list.
 */
export function checkColumns(
  value: unknown,
  header: readonly string[],
  body: readonly { cells: string[] }[],
): Column[] | null {
  const guessed = guessColumns(header, body);
  const said = new Map<number, ColumnMeaning>();
  const uses = new Map<number, string>();
  const v = value as { columns?: { index?: unknown; meaning?: unknown; use?: unknown }[] } | null;
  for (const c of v?.columns ?? []) {
    const i = Number(c.index);
    if (Number.isInteger(i) && i >= 0 && i < header.length && MEANINGS.includes(c.meaning as ColumnMeaning)) said.set(i, c.meaning as ColumnMeaning);
    if (Number.isInteger(i) && typeof c.use === "string" && clean(c.use)) uses.set(i, clean(c.use).replace(/\s*[–—]\s*/g, ", ").slice(0, 240));
  }
  const col = (i: number) => body.map((r) => r.cells[i] ?? "");
  const cols: Column[] = header.map((h, index) => {
    const m = said.get(index) ?? guessed[index].meaning;
    const share = phoneShare(col(index));
    if ((m === "phone" || m === "alt_phone") && share < 0.6) return { index, header: h, meaning: guessed[index].meaning === "phone" || guessed[index].meaning === "alt_phone" ? "ignore" : guessed[index].meaning };
    if ((m === "name" || m === "first_name" || m === "last_name") && share >= 0.6) return { index, header: h, meaning: guessed[index].meaning };
    // A column headed as remarks or a note is read, whatever the model thought of it.
    if (m === "ignore" && meaningFromHeader(h) === "context" && col(index).some((x) => clean(x))) return { index, header: h, meaning: "context" };
    return { index, header: h, meaning: m };
  });
  // A column of flat sizes ("2 BHK") is something to know about the person, never the tower.
  for (const c of cols) if (c.meaning === "project" && sizeShare(col(c.index)) >= 0.5) c.meaning = "context";
  // Exactly one phone column: the model's if it holds phones, else the guess's.
  const phones = cols.filter((c) => c.meaning === "phone");
  if (phones.length !== 1) {
    const pick = phones.sort((a, b) => phoneShare(col(b.index)) - phoneShare(col(a.index)))[0] ?? cols.find((c) => c.index === guessed.find((g) => g.meaning === "phone")?.index);
    for (const c of cols) if (c.meaning === "phone" && c !== pick) c.meaning = "alt_phone";
    if (pick) pick.meaning = "phone";
  }
  for (const c of cols) if (c.meaning === "context" && uses.has(c.index)) c.use = uses.get(c.index);
  return cols.some((c) => c.meaning === "phone") ? cols : null;
}

export function columnsPrompt(tower = ""): string {
  return `You read a spreadsheet a real-estate sales team uploaded: people they want an AI agent to phone about a housing project in India. The sheet may hold thousands of people, so you work out what each COLUMN means and how it should shape the calls, never anything about one person.${tower ? `

The team already chose the project: everyone on this list is about ${tower}. A sheet with no project column is normal; never ask which project, tower or building anybody is about.` : ""}

You are given each column's header with its values: every distinct value and how often it appears when there are few, else a spread of examples. Digits that could be phone numbers are hidden on purpose.

For every column say what it holds:
- name: the person's full name
- first_name, last_name: when the name is split
- phone: the main mobile number (exactly one column)
- alt_phone: any other number
- language: the language to speak (Hindi, Marathi, English)
- project: the name of the project, tower or building they are about (never a flat size like 2 BHK)
- context: anything the agent should know about a person or what to say to them: remarks, notes, status, stage, budget, configuration, last discussion, visit, follow-up, source, special instructions
- ignore: serial numbers, ids, emails, dates and anything else

For every context column also write use: one plain sentence on how a value in it should shape a person's call, as a rule for the whole column ("Remarks: follow any time to call, language or manner it gives, and use what the person liked", "Stage: SV-D means the site visit is done, so ask how it went; FU-2 is a second follow-up"). When you cannot tell what its values mean, say so in use and ask below; the use itself never tells anybody to ask the team.

Then say in one sentence what this list is (who these people are), and suggest what the call should have achieved by its end for most of them, as an end state in one short sentence of under 120 characters ("A site visit agreed this weekend, if the project fits what they need"), never as what to say or do first. The suggestion carries no price, no offer, no number and no dash.

Last, the questions the team must answer before anybody is called, at most 4. Each is about a COLUMN and its values, never about one person or one row: codes you cannot read in a status or category column ("What do P1, P3 and NR in the Cat column mean?"), a column whose purpose you cannot tell, or a kind of instruction that keeps appearing whose meaning is unclear ("Remarks often give call times like 3 to 5. Should the agent call only inside them?"). Never ask which number to ring: the system rings the main mobile number. Name the column by its header, never by its number. One short sentence a sales head understands, with two to four answers they could pick, each two to six words. A column you can read needs no question; no questions is the usual answer.`;
}

/** How each column of a sheet looks: every distinct value when there are few, else a spread of examples. */
export function columnProfile(header: readonly string[], body: readonly { cells: string[] }[]): string {
  const lines: string[] = [`${body.length} people. Columns:`];
  header.forEach((h, i) => {
    const values = body.map((r) => clean(r.cells[i])).filter(Boolean);
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const blank = body.length - values.length;
    let shown: string;
    if (!values.length) shown = "always empty";
    else if (counts.size <= 12 && counts.size < values.length) {
      shown = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `"${hideDigits(v).slice(0, 60)}" x${n}`).join(", ");
    } else {
      const picks = sampleIndexes(values.length, 8, h).map((k) => values[k]);
      shown = `${counts.size} different values, for example: ${picks.map((v) => `"${hideDigits(v).slice(0, 120)}"`).join("; ")}`;
    }
    lines.push(`[${i}] ${h}: ${shown}${blank && values.length ? ` (empty in ${blank})` : ""}`);
  });
  return lines.join("\n");
}

/** The most questions one list asks, and the rounds of asking before the system decides for itself. */
export const MAX_QUESTIONS = 4;

export type ListQuestion = {
  id: string;
  text: string;
  options: string[];
  /** The column it is about, by its header; null when it is about the sheet. */
  column: string | null;
  /** The people it is about; empty is the whole list. */
  lines: number[];
  answer: string | null;
  /** "Decide for me": answered by leaving it to the system. */
  skipped: boolean;
};

const QUESTIONS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["question", "column", "options"],
    properties: { question: { type: "string" }, column: { type: "string" }, options: { type: "array", items: { type: "string" } } },
  },
};

const cleanOptions = (raw: unknown): string[] =>
  [...new Set((Array.isArray(raw) ? raw : []).filter((o): o is string => typeof o === "string").map((o) => clean(o).slice(0, 80)).filter(Boolean))].slice(0, 4);

/**
 * A question about which project, tower or building the list is for. The
 * person picked the tower on upload, so the sheet never needs to say.
 */
export function asksForProject(text: string): boolean {
  return /\b(project|tower|building|wing|property|site)s?\b/i.test(text) && /\b(which|what|column|who|where)\b/i.test(text);
}

/** The questions the column read raised, about columns only, checked and capped. */
export function readColumnQuestions(value: unknown, header: readonly string[] = []): { text: string; options: string[]; column: string | null }[] {
  const v = value as { questions?: unknown[] } | null;
  return (v?.questions ?? [])
    .map((q) => q as { question?: unknown; options?: unknown; column?: unknown })
    .map((q) => {
      const col = clean(typeof q.column === "string" ? q.column : "");
      return {
        text: clean(typeof q.question === "string" ? q.question : "").slice(0, 200),
        options: cleanOptions(q.options),
        column: header.find((h) => h.toLowerCase() === col.toLowerCase()) ?? null,
      };
    })
    .filter((q) => q.text.length >= 8 && !asksForProject(q.text))
    .slice(0, MAX_QUESTIONS);
}

const questionKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The column read's questions as the person is asked them: one each, the
 * same question once, never a dash on the screen.
 */
export function gatherQuestions(asked: readonly { text: string; options: string[]; column?: string | null }[], makeId: (n: number) => string): ListQuestion[] {
  // The screen never shows a dash: a range reads "15:00 to 17:00", an aside a comma.
  const undash = (t: string) => t.replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2").replace(/\s*[–—]\s*/g, ", ");
  const seen = new Set<string>();
  const out: ListQuestion[] = [];
  for (const q of asked) {
    const text = undash(q.text);
    const k = questionKey(text);
    if (seen.has(k) || out.length >= MAX_QUESTIONS) continue;
    seen.add(k);
    out.push({ id: makeId(out.length), text, options: q.options.map(undash), column: q.column ?? null, lines: [], answer: null, skipped: false });
  }
  return out;
}

/**
 * How to read the sheet, as each person's read is told it: every context
 * column's rule, then what the team answered about the columns.
 */
export function sheetGuide(columns: readonly Column[], questions: readonly ListQuestion[]): string {
  const uses = columns.filter((c) => c.meaning === "context" && c.use).map((c) => `- ${c.header}: ${c.use}`);
  const said = questions.filter((q) => q.answer || q.skipped);
  return [
    ...(uses.length ? ["How to read this sheet's columns, the same for everybody:", ...uses] : []),
    ...(said.length
      ? ["The team answered these questions about the sheet. Follow the answers for everybody:", ...said.map((q) => `- ${q.column ? `${q.column} column: ` : ""}${q.text} Answer: ${q.answer ?? "Use your own judgement."}`)]
      : []),
  ].join("\n");
}

/** The answers a form sent, kept only for questions still open and options or words of the person's own. */
export function applyAnswers(
  questions: readonly ListQuestion[],
  given: Readonly<Record<string, { pick?: string; other?: string; skip?: boolean }>>,
): { questions: ListQuestion[]; answered: ListQuestion[]; missing: number } {
  let missing = 0;
  const answered: ListQuestion[] = [];
  const next = questions.map((q) => {
    if (q.answer || q.skipped) return q;
    const g = given[q.id];
    const other = clean(g?.other ?? "").slice(0, 300);
    const pick = g?.pick && q.options.includes(g.pick) ? g.pick : null;
    if (g?.skip) {
      const done = { ...q, skipped: true };
      answered.push(done);
      return done;
    }
    const answer = other || pick;
    if (!answer) {
      missing += 1;
      return q;
    }
    const done = { ...q, answer };
    answered.push(done);
    return done;
  });
  return { questions: next, answered, missing };
}

export const openQuestions = (qs: readonly ListQuestion[]) => qs.filter((q) => !q.answer && !q.skipped);

export function columnsSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["columns", "purpose", "goal", "questions"],
    properties: {
      columns: {
        type: "array",
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "meaning", "use"],
          properties: { index: { type: "integer" }, meaning: { type: "string", enum: [...MEANINGS] }, use: { type: "string" } },
        },
      },
      purpose: { type: "string" },
      goal: { type: "string" },
      questions: QUESTIONS_SCHEMA,
    },
  };
}

/** The header and sampled rows as the model is shown them, every phone hidden. */
export function columnsInput(header: readonly string[], sample: readonly { cells: string[] }[]): string {
  const lines = [`Columns: ${header.map((h, i) => `[${i}] ${h}`).join(" | ")}`, "", "Random rows:"];
  for (const r of sample) lines.push(r.cells.map((c, i) => `[${i}] ${hideDigits(c).slice(0, 160)}`).join(" | "));
  return lines.join("\n");
}

/** What the model said the list is for, kept short and sentence-shaped. */
export function readPurpose(value: unknown): { purpose: string; goal: string | null } {
  const v = value as { purpose?: unknown; goal?: unknown } | null;
  const purpose = clean(typeof v?.purpose === "string" ? v.purpose : "").slice(0, 300);
  const g = tidyGoal(typeof v?.goal === "string" ? v.goal : "");
  return { purpose, goal: g && !goalProblem(g) ? g : null };
}

// ---------------------------------------------------------------------------
// The people
// ---------------------------------------------------------------------------

export type ListPerson = {
  line: number;
  name: string;
  phone: string | null;
  /** The raw value from the number column, for the refusal when it is not a number. */
  phoneAsTyped: string;
  language: Language | null;
  project: string | null;
  /** Everything the context columns hold, "Header: value", digits that look like phones hidden. */
  context: string;
};

const LANGUAGE_WORDS: [Language, RegExp][] = [
  ["mr", /\b(marathi|mr|मराठी)\b/i],
  ["hi", /\b(hindi|hinglish|hi|हिंदी|हिन्दी)\b/i],
  ["en", /\b(english|en|eng)\b/i],
];

export function languageOf(cell: string): Language | null {
  for (const [l, re] of LANGUAGE_WORDS) if (re.test(cell)) return l;
  return null;
}

export function personOf(row: { line: number; cells: string[] }, cols: readonly Column[]): ListPerson {
  const of = (m: ColumnMeaning) => cols.filter((c) => c.meaning === m).map((c) => row.cells[c.index] ?? "").filter(Boolean);
  const full = of("name")[0] ?? "";
  const name = clean(full || [of("first_name")[0], of("last_name")[0]].filter(Boolean).join(" ")).slice(0, 120);
  const typed = of("phone")[0] ?? "";
  const phone = phoneOf(typed) ?? of("alt_phone").map(phoneOf).find(Boolean) ?? null;
  const lang = of("language").map(languageOf).find(Boolean) ?? null;
  const context = cols
    .filter((c) => c.meaning === "context" && clean(row.cells[c.index]))
    .map((c) => `${c.header}: ${hideDigits(clean(row.cells[c.index]))}`)
    .join("; ")
    .slice(0, NOTE_MAX);
  return { line: row.line, name, phone, phoneAsTyped: clean(typed), language: lang, project: of("project")[0] ?? null, context };
}

export type Tower = { id: string; name: string; project: string | null };

/** A tower a list pitches, as the remarks reader is told it: "Sath Heights Tower C (Goregaon West): 1 BHK from Rs 76 lakh". */
export type PitchedTower = Tower & { about: string };

/** What a tower sells, in a line the remarks reader can match a size, a budget or a place against. */
export function towerLine(t: { name: string; project: string | null; location: string | null; homes: { label: string; price: number | null }[] }): string {
  const lakh = (p: number) => (p >= 1e7 ? `Rs ${(p / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr` : `Rs ${Math.round(p / 1e5)} lakh`);
  const homes = t.homes.slice(0, 5).map((h) => (h.price ? `${h.label} from ${lakh(h.price)}` : h.label));
  return `${t.project ? `${t.project} ${t.name}` : t.name}${t.location ? ` (${t.location})` : ""}${homes.length ? `: ${homes.join(", ")}` : ""}`;
}

/**
 * The tower a cell names: the tower's own name, "Project Tower", or a
 * project that has one tower. Two that fit is no answer.
 */
export function towerNamed(cell: string | null, towers: readonly Tower[]): Tower | null {
  const v = clean(cell ?? "").toLowerCase();
  if (!v) return null;
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const want = squash(v);
  const hits = towers.filter((t) => squash(t.name) === want || (t.project && (squash(`${t.project}${t.name}`) === want || squash(`${t.name}${t.project}`) === want)));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;
  const byProject = towers.filter((t) => t.project && squash(t.project) === want);
  return byProject.length === 1 ? byProject[0] : null;
}

// ---------------------------------------------------------------------------
// What each person's call should do
// ---------------------------------------------------------------------------

export function notesPrompt(purpose: string, goal: string | null, todayIst: string, guide = "", tower = "", towers: readonly PitchedTower[] = []): string {
  const many = towers.length > 1;
  return `A real-estate sales team in India uploaded a list of people for an AI agent to phone${many ? "" : tower ? ` about ${tower}` : ""}. Today is ${todayIst} (India). ${purpose ? `The list: ${purpose}.` : ""}
${many ? `\nThe team wants these towers offered to this list, each call about one of them with the others as alternatives:\n${towers.map((t, i) => `${i + 1}. ${t.about}`).join("\n")}\n` : ""}
${goal ? `For most of them the call should: ${goal}.` : "For most of them the call is a plain first conversation about the project."}
${guide ? `\n${guide}\n` : ""}
For each person below you get only what the sheet's columns say about them. Read each the way the guide above says; where a remark is untidy ("call betw 3 to 5, 6"), take its most sensible reading yourself. Never ask about a person. Decide:
- call: false only when the remarks clearly say not to call them now (not interested, already bought, wrong number, do not disturb, asked not to be called, a broker or agent, a duplicate). Otherwise true.
- reason: when call is false, a few plain words why ("Said not interested").
- goal: what this person's call should have achieved by its end, one sentence of at most 200 characters, using what the remarks say ("Know what held them back after last month's visit, and a second visit with the family agreed if they are still keen"); an end state, never a script of what to say first. How to talk to them belongs here too ("Speak only in English", "Keep it short, they are busy", "Address them formally"). Never about when to call. Keep every instruction the remarks give about what not to say. Leave it empty when the remarks add nothing to the list's own purpose.
- enquired: "yes" when the remarks or the list say this person enquired (filled a form, called in, came from an ad or a portal, visited, asked about a project); "no" when they say this person never enquired, or that this is a cold call or a cold list; else "unknown". Only "yes" lets the agent say they enquired.
- language: the language the remarks say to speak ("English only" is "en"), or "unknown".
- call_on: the day to call when the remarks name one, as YYYY-MM-DD, else "".
- call_from, call_until: the hours of the day to call between when the remarks name them, as HH:MM in India time, else "". "Between 3 and 5" is "15:00" to "17:00"; "after 6 pm" is "18:00" and ""; "before 11" is "" and "11:00". An hour from 1 to 7 with no am or pm is the afternoon or evening.
- tower: ${many ? "the number of the tower above this person's remarks fit best (a size, a budget or a place they asked for), or 0 when nothing in them picks one." : "always 0."}

Rules for the goal, which are checked: no price, budget, amount, discount or offer; no phone number, email or link; no numbers at all except a day and a time and a flat size like 2 BHK; no dash; never ask for ID, bank details or an OTP; nothing the remarks do not say. If the remarks are about money, say "they asked about the price" without the figure.`;
}

export function notesSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["people"],
    properties: {
      people: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["line", "call", "reason", "goal", "enquired", "language", "call_on", "call_from", "call_until", "tower"],
          properties: {
            line: { type: "integer" },
            call: { type: "boolean" },
            reason: { type: "string" },
            goal: { type: "string" },
            enquired: { type: "string", enum: ["yes", "no", "unknown"] },
            language: { type: "string", enum: ["hi", "mr", "en", "unknown"] },
            call_on: { type: "string" },
            call_from: { type: "string" },
            call_until: { type: "string" },
            tower: { type: "integer" },
          },
        },
      },
    },
  };
}

export function notesInput(people: readonly Pick<ListPerson, "line" | "context">[]): string {
  return people.map((p) => `Line ${p.line}: ${p.context}`).join("\n");
}

export type RowNote = {
  line: number;
  call: boolean;
  reason: string | null;
  goal: string | null;
  language: Language | null;
  goalDropped: boolean;
  /** Whether this person ever enquired: true, false, or null when nothing says. */
  enquired: boolean | null;
  /** The day and the time of day the remarks asked for, India time. */
  callOn: string | null;
  callFrom: string | null;
  callUntil: string | null;
  /** Which of the list's towers the remarks fit, counted from 1; null when none. */
  towerPick: number | null;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A goal without "call after 6 pm" and the like: the call is placed then instead. */
export function withoutWhen(raw: string): string {
  const when = /\b(please\s+)?(call|ring|phone|contact)(\s+(them|him|her))?\s+(only\s+)?(after|at|on|before|from|around|by)\s+(\d{1,2}([:.]\d{2})?\s*(am|pm|hrs)?|\d{4}-\d{2}-\d{2}|(this\s+|next\s+)?[a-z]+day|today|tomorrow|(the\s+)?(morning|evening|afternoon|night|noon|weekend))(\s+only)?\s*(and\s+|then\s+|[;,.]\s*)?/gi;
  // "Call tomorrow morning to invite them" keeps "invite them".
  const lead = /\b(please\s+)?(call|ring|phone)(\s+(them|him|her))?\s+(tomorrow|today|tonight|(this|next)\s+[a-z]+|on\s+[a-z]+day)(\s+(morning|afternoon|evening|night))?(\s+to)?\s+/gi;
  const out = raw
    .replace(when, "")
    .replace(lead, "")
    .replace(/^\s*[;,]\s*/, "")
    .replace(/[;,]\s*$/, "")
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The model's "yes", "no" or "unknown" about an enquiry, as a row stores it. */
export const enquiredOf = (v: unknown): boolean | null => (v === "yes" ? true : v === "no" ? false : null);

/** Where a list's people came from, as the person uploading it says. */
export const LIST_SOURCES = ["ENQUIRED", "COLD", "MIXED"] as const;
export type ListSource = (typeof LIST_SOURCES)[number];
export const LIST_SOURCE_LABEL: Record<ListSource, { label: string; hint: string }> = {
  ENQUIRED: { label: "They enquired", hint: "Filled a form, called in, or came from a portal" },
  COLD: { label: "They never enquired", hint: "A cold list, bought data or another source" },
  MIXED: { label: "A mix", hint: "Each person's remarks say which" },
};
export const readListSource = (v: unknown): ListSource | null => ((LIST_SOURCES as readonly unknown[]).includes(v) ? (v as ListSource) : null);

/**
 * Whether the agent may say this person enquired. A cold list never; a list
 * of enquiries yes, unless the person's own remarks say they never did; a
 * mix only when the remarks say they did. Told nothing, the agent speaks of
 * the project without saying they asked about it.
 */
export function mayCallEnquired(enquired: boolean | null | undefined, source: ListSource = "MIXED"): boolean {
  if (source === "COLD") return false;
  if (source === "ENQUIRED") return enquired !== false;
  return enquired === true;
}

/**
 * What a cold contact's call does when neither the row nor the list says:
 * a cold call goes to the goal agent, the one agent told how to open one.
 */
export const COLD_GOAL = "By the end of the call: know whether they are looking for a home and what they need; a site visit agreed only if the project fits";

/** A goal as the agent and the screen read it: one line, no dashes. */
export function tidyGoal(raw: string): string {
  return clean(raw).replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/,\s*,/g, ",").slice(0, GOAL_MAX);
}

/**
 * The model's notes, checked. A goal that breaks a rule is dropped, never
 * trimmed into one that passes: the person then gets the list's own goal.
 */
export function checkNotes(value: unknown, lines: readonly number[]): Map<number, RowNote> {
  const out = new Map<number, RowNote>();
  const v = value as { people?: unknown[] } | null;
  for (const raw of v?.people ?? []) {
    const p = raw as { line?: unknown; call?: unknown; reason?: unknown; goal?: unknown; language?: unknown };
    const line = Number(p.line);
    if (!lines.includes(line) || out.has(line)) continue;
    const on = typeof (p as { call_on?: unknown }).call_on === "string" ? clean((p as { call_on: string }).call_on) : "";
    const from = typeof (p as { call_from?: unknown }).call_from === "string" ? clean((p as { call_from: string }).call_from) : "";
    const until = typeof (p as { call_until?: unknown }).call_until === "string" ? clean((p as { call_until: string }).call_until) : "";
    // When to call is the schedule's, never words the agent says on the call.
    const g = tidyGoal(withoutWhen(typeof p.goal === "string" ? p.goal : ""));
    const ok = g && !goalProblem(g);
    out.set(line, {
      line,
      call: p.call !== false,
      reason: p.call === false ? clean(typeof p.reason === "string" ? p.reason : "").slice(0, 120) || "The remarks say not to call" : null,
      goal: ok ? g : null,
      language: p.language === "hi" || p.language === "mr" || p.language === "en" ? p.language : null,
      goalDropped: Boolean(g && !ok),
      enquired: enquiredOf((p as { enquired?: unknown }).enquired),
      callOn: /^\d{4}-\d{2}-\d{2}$/.test(on) && !Number.isNaN(Date.parse(on)) ? on : null,
      callFrom: HHMM.test(from) ? from : null,
      callUntil: HHMM.test(until) ? until : null,
      towerPick: Number.isInteger((p as { tower?: unknown }).tower) && Number((p as { tower: number }).tower) > 0 ? Number((p as { tower: number }).tower) : null,
    });
  }
  return out;
}

export type PlannedRow = {
  line: number;
  name: string;
  phone: string | null;
  language: Language;
  towerId: string | null;
  note: string | null;
  goal: string | null;
  enquired: boolean | null;
  state: "READY" | "SKIPPED";
  reason: string | null;
  /** The earliest moment to ring, when the remarks asked for one. */
  notBefore: string | null;
  /** The hours of the day this person may be rung in, India time, on every try. */
  windowFrom: string | null;
  windowTo: string | null;
};

/**
 * The hours a remark allows, India time: "between 3 and 5" is 15:00 to
 * 17:00, "after 6 pm" runs to the end of calling hours, "before 11" starts
 * at their start. A window that closes before it opens is no window.
 */
export function windowOf(from: string | null, until: string | null): { from: string; to: string } | null {
  if (!from && !until) return null;
  // Never outside calling hours: "morning" from nine opens at ten.
  const open = `${String(CALLING_HOURS.from).padStart(2, "0")}:00`;
  const close = `${String(CALLING_HOURS.to).padStart(2, "0")}:00`;
  const f = from && from > open ? from : open;
  const t = until && until < close ? until : close;
  return f < t ? { from: f, to: t } : null;
}

/** When a person with a window may next be rung: null when now is inside it. */
export function windowWait(w: { from: string; to: string } | null, nowIso: string): string | null {
  if (!w) return null;
  const now = Date.parse(nowIso);
  const day = istDate(nowIso);
  const open = Date.parse(`${day}T${w.from}:00+05:30`);
  const close = Date.parse(`${day}T${w.to}:00+05:30`);
  if (now >= open && now < close) return null;
  if (now < open) return new Date(open).toISOString();
  return new Date(open + 86_400_000).toISOString();
}

/**
 * The moment a remark's day and time mean, India time. A time alone is
 * today's; a day alone opens at ten. A moment already past is no wait.
 */
export function whenAsked(callOn: string | null, callFrom: string | null, nowIso: string): string | null {
  if (!callOn && !callFrom) return null;
  const at = Date.parse(`${callOn ?? istDate(nowIso)}T${callFrom ?? "10:00"}:00+05:30`);
  if (Number.isNaN(at) || at <= Date.parse(nowIso)) return null;
  // Further out than two months is a misreading, not a plan.
  if (at - Date.parse(nowIso) > 62 * 86_400_000) return null;
  return new Date(at).toISOString();
}

/**
 * Each person's row, decided: who is called, about which tower, in which
 * language, to do what, and why anybody is skipped. The same number twice
 * is called once.
 */
export function planRows(
  people: readonly ListPerson[],
  notes: ReadonlyMap<number, RowNote>,
  o: { towers: readonly Tower[]; defaultTower: string; nowIso: string },
): PlannedRow[] {
  const seen = new Map<string, number>();
  return people.map((p) => {
    const n = notes.get(p.line);
    // The sheet's own project column first, then what the remarks fit, then the first chosen.
    const named = p.project ? towerNamed(p.project, o.towers) : null;
    const base = {
      line: p.line,
      name: p.name,
      phone: p.phone,
      language: n?.language ?? p.language ?? (guessLanguage(p.name) as Language | null) ?? "hi",
      towerId: named?.id ?? pickedTower(n, o.towers) ?? o.defaultTower,
      note: p.context || null,
      ...timingOf(n, o.nowIso),
      goal: n?.goal ?? null,
      enquired: n?.enquired ?? null,
    };
    const skip = (reason: string): PlannedRow => ({ ...base, state: "SKIPPED", reason });
    if (!p.phone) return skip(p.phoneAsTyped ? `"${hideDigits(p.phoneAsTyped).slice(0, 20)}" is not a phone number` : "No phone number");
    if (!p.name) return skip("No name");
    const first = seen.get(p.phone);
    if (first !== undefined) return skip(`Same number as line ${first}`);
    seen.set(p.phone, p.line);
    return { ...base, ...verdictOf(n) };
  });
}

/** The tower a note's pick names among the list's, counted from 1. */
export function pickedTower(n: RowNote | undefined, towers: readonly Tower[]): string | null {
  return n?.towerPick && n.towerPick <= towers.length ? towers[n.towerPick - 1].id : null;
}

/** When a row may be rung, from its note. */
export function timingOf(n: RowNote | undefined, nowIso: string): { notBefore: string | null; windowFrom: string | null; windowTo: string | null } {
  const w = n ? windowOf(n.callFrom, n.callUntil) : null;
  // A day asked for opens at the window's start, or at ten.
  const at = n ? whenAsked(n.callOn, n.callOn ? (w?.from ?? null) : w ? null : n.callFrom, nowIso) : null;
  return { notBefore: at, windowFrom: w?.from ?? null, windowTo: w?.to ?? null };
}

/** Called or skipped, from its note alone: the half of a row a later answer can change. */
export function verdictOf(n: RowNote | undefined): { state: "READY" | "SKIPPED"; reason: string | null } {
  if (n && !n.call) return { state: "SKIPPED", reason: n.reason ?? "The remarks say not to call" };
  return { state: "READY", reason: n?.goalDropped ? "Remark left out: it carried a price or a number" : null };
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

/** What a finished call means for its row: spoke, try again later, or give up. */
export function afterListCall(o: { connectivity: string | null; tries: number; nowIso: string }): { state: "CALLED" | "READY" | "UNREACHED"; notBefore: string | null } {
  if (o.connectivity === "connected") return { state: "CALLED", notBefore: null };
  if (o.tries >= LIST_TRIES) return { state: "UNREACHED", notBefore: null };
  return { state: "READY", notBefore: nextListTry(o.nowIso) };
}

/**
 * What a list's row says once its call ended: what happened on the call, in
 * the call log's own words, and what comes next. "No answer" was said of
 * every call that did not connect, a declined one included.
 */
export function listRowReason(o: {
  state: "CALLED" | "READY" | "UNREACHED";
  outcomeLabel: string | null;
  tries: number;
}): string | null {
  const what = o.outcomeLabel ?? "No answer";
  if (o.state === "READY") return `${what}, trying again tomorrow`;
  if (o.state === "UNREACHED") return `Not reached in ${o.tries} ${o.tries === 1 ? "try" : "tries"} (last: ${what.toLowerCase()})`;
  return o.outcomeLabel;
}

/**
 * When a person nobody reached is rung again: the next day, three hours
 * later in the day than this try, between 11 am and 7 pm India time. A
 * cold contact rung three times in one afternoon learns to decline the
 * number (27 October 2026); three tries on three days, at different hours,
 * catch somebody who was only busy.
 */
export function nextListTry(nowIso: string): string {
  const ist = new Date(Date.parse(nowIso) + 330 * 60_000);
  let mins = ist.getUTCHours() * 60 + ist.getUTCMinutes() + 180;
  if (mins > 19 * 60) mins = 11 * 60 + (mins - 19 * 60);
  mins = Math.min(Math.max(mins, 11 * 60), 19 * 60);
  const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1));
  return new Date(day.getTime() + mins * 60_000 - 330 * 60_000).toISOString();
}

/**
 * Before a list rings somebody again: the lead may have moved on since the
 * list's last try. The engine retries its own calls too, so a buyer who has
 * since spoken, been closed or booked is never rung again by the list, and a
 * call placed after the list's own waits the list's gap from that one.
 */
export function listRetry(o: {
  stage: string | null;
  erased: boolean;
  spokeSince: boolean;
  lastCallIso: string | null;
  nowIso: string;
}): { state: "CALLED" | "SKIPPED"; reason: string } | { state: "WAIT"; notBefore: string } | null {
  if (o.erased) return { state: "SKIPPED", reason: "The buyer's details were erased" };
  if (o.stage === "lost") return { state: "SKIPPED", reason: "The lead was closed" };
  if (o.stage === "booked") return { state: "SKIPPED", reason: "The buyer has booked" };
  if (o.spokeSince) return { state: "CALLED", reason: "Spoke on a later call" };
  if (o.lastCallIso && Date.parse(o.lastCallIso) + LIST_RETRY_MS > Date.parse(o.nowIso)) {
    return { state: "WAIT", notBefore: new Date(Date.parse(o.lastCallIso) + LIST_RETRY_MS).toISOString() };
  }
  return null;
}

/** Refusals that stop the whole list rather than one person: nobody else on it would get through either. */
export const LIST_STOPPERS = ["NOT_SWITCHED_ON", "ALLOWANCE", "NO_PLAN", "NO_NUMBER", "NOT_ADVERTISABLE", "NOT_IN_PLAN"] as const;
/** Refusals that wait and try the same person again on a later pass. */
export const LIST_WAITERS = ["BUSY", "OUTSIDE_HOURS"] as const;

export type ListCounts = Record<ListRowState, number>;
export function countRows(rows: readonly { state: ListRowState }[]): ListCounts {
  const c: ListCounts = { READY: 0, SKIPPED: 0, CALLING: 0, CALLED: 0, UNREACHED: 0, REFUSED: 0 };
  for (const r of rows) c[r.state] += 1;
  return c;
}

/** The consent a list's starter gives for everyone on it. */
export function listConsentWording(developer: string): string {
  return `I agree to be contacted by ${developer} by call and WhatsApp about its projects.`;
}
