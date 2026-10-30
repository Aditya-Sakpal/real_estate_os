import { audit, withTenant } from "./db/index.ts";
import { transcribe } from "./stt.ts";
import { isNodeId } from "./scope-rules.ts";
import {
  carrierLine,
  heardAsMeant,
  isDue,
  projectPathOf,
  REGIONS,
  regionFor,
  SAYING_CAPS,
  sayingProblem,
  wordsToCheck,
  wordsToSay,
  type Saying,
} from "./pronounce-rules.ts";

/**
 * How the calling agent says a project's words: read, checked by ear,
 * corrected by the developer, and handed to every call. `pronounce-rules.ts`
 * is the pure half.
 *
 * A check says each word in the agent's own voice (Sarvam Bulbul, `advait`,
 * the agents' pace), hears it back (Saaras), and compares by sound with how
 * the word is meant to sound: the developer's spelling, the region list's, or
 * the word put into Devanagari by Sarvam's transliteration. Every paid call is
 * capped and counted before it is made (`SAYING_CAPS`), and its cost is kept
 * on the row. Never charged to anybody.
 */

export type Verdict = "UNCHECKED" | "RIGHT" | "WRONG" | "FAILED";

export type Word = {
  written: string;
  /** How the developer wrote it is said, at this node or one above. */
  said: string | null;
  /** Where that spelling was set: this node, or the place above it. */
  saidAt: string | null;
  /** How the region's list says it, when it holds the word. */
  regionSaid: string | null;
  heard: string | null;
  verdict: Verdict;
  checkedAt: string | null;
  /** Whether a sample of the agent saying it, as it would now, is kept. */
  sampled: boolean;
};

export type Place = { id: string; kind: string; label: string; city: string | null; region: string | null; path: string };

/** The voice the calls speak in, and its pace: the sample has to be the call's. */
const CALL_VOICE = process.env.SARVAM_CALL_VOICE || "advait";
const CALL_PACE = 1.15;
/** Words said and heard at the same time in one check. */
const CHECK_AT_ONCE = 4;

/** Rs 30 for 10,000 characters spoken, Rs 20 for 10,000 transliterated, Rs 30 an hour heard. */
const SPEAK_PAISE_PER_CHAR = 0.3;
const SPELL_PAISE_PER_CHAR = 0.2;
const HEAR_PAISE_PER_SECOND = 3000 / 3600;

export type SpeechDrivers = {
  say: (text: string, language: string) => Promise<Buffer | null>;
  hear: (wav: Buffer) => Promise<string | null>;
  spell: (word: string) => Promise<string | null>;
};

let injected: SpeechDrivers | null = null;
/** For the checks: speech that never leaves the machine. */
export function useSpeech(d: SpeechDrivers | null): void {
  injected = d;
}

const sarvamSpeech: SpeechDrivers = {
  async say(text, language) {
    const key = process.env.SARVAM_API_KEY;
    if (!key) return null;
    const r = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: { "api-subscription-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, language_code: language, speaker: CALL_VOICE, model: "bulbul:v3", pace: CALL_PACE, speech_sample_rate: "16000", output_audio_codec: "wav" }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!r?.ok) return null;
    const audio = ((await r.json().catch(() => ({}))) as { audios?: string[] }).audios?.[0];
    return audio ? Buffer.from(audio, "base64") : null;
  },
  async hear(wav) {
    const h = await transcribe({ bytes: wav, contentType: "audio/wav", mode: "transcribe" });
    return h.ok ? h.text : null;
  },
  async spell(word) {
    const key = process.env.SARVAM_API_KEY;
    if (!key) return null;
    const r = await fetch("https://api.sarvam.ai/transliterate", {
      method: "POST",
      headers: { "api-subscription-key": key, "content-type": "application/json" },
      body: JSON.stringify({ input: word, source_language_code: "en-IN", target_language_code: "hi-IN" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!r?.ok) return null;
    const out = ((await r.json().catch(() => ({}))) as { transliterated_text?: string }).transliterated_text;
    return out?.trim() || null;
  },
};
const speech = () => injected ?? sarvamSpeech;

/** A WAV's length in seconds, from its header. */
function wavSeconds(wav: Buffer): number {
  if (wav.length < 44) return 0;
  const rate = wav.readUInt32LE(28);
  return rate > 0 ? (wav.length - 44) / rate : 0;
}

const key = (w: string) => w.trim().toLowerCase();

async function placeOf(orgId: string, nodeId: string): Promise<(Place & { developer: string; parentName: string | null; grandName: string | null; name: string }) | null> {
  if (!isNodeId(nodeId)) return null;
  return withTenant(orgId, async (sql) => {
    const [n] = await sql<{ id: string; kind: string; name: string; path: string; parent_name: string | null; grand_name: string | null; developer: string }[]>`
      SELECT n.id, n.kind, n.name, n.path::text AS path, p.name AS parent_name, g.name AS grand_name,
             coalesce(o.display_name, o.legal_name) AS developer
      FROM scope_nodes n
      JOIN orgs o ON o.id = n.org_id
      LEFT JOIN scope_nodes p ON p.id = n.parent_id
      LEFT JOIN scope_nodes g ON g.id = p.parent_id
      WHERE n.org_id = ${orgId} AND n.id = ${nodeId} AND n.kind IN ('PROJECT', 'PHASE')`;
    if (!n) return null;
    const city = n.kind === "PHASE" ? n.grand_name : n.parent_name;
    return {
      id: n.id,
      kind: n.kind,
      name: n.name,
      path: n.path,
      label: n.kind === "PHASE" && n.parent_name ? `${n.parent_name} · ${n.name}` : n.name,
      city,
      region: regionFor(city),
      developer: n.developer,
      parentName: n.parent_name,
      grandName: n.grand_name,
    };
  });
}

type Row = {
  id: string;
  scope_node_id: string;
  written: string;
  said: string | null;
  heard: string | null;
  verdict: Verdict;
  sample_of: string | null;
  has_sample: boolean;
  checked_at: Date | null;
  depth: number;
  place: string;
};

/** The words set at this node and every node above it, deepest first. */
async function rowsAbove(orgId: string, path: string): Promise<Row[]> {
  return withTenant(orgId, (sql) => sql<Row[]>`
    SELECT w.id, w.scope_node_id, w.written, w.said, w.heard, w.verdict, w.sample_of, (w.sample IS NOT NULL) AS has_sample,
           w.checked_at, nlevel(n.path) AS depth,
           CASE WHEN n.kind = 'PHASE' THEN coalesce(p.name || ' · ', '') || n.name ELSE n.name END AS place
    FROM pronunciations w
    JOIN scope_nodes n ON n.id = w.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = n.parent_id
    WHERE w.org_id = ${orgId} AND n.path @> ${path}::ltree
    ORDER BY nlevel(n.path) DESC, w.written`);
}

/** The facts a call about this node carries, for finding its words. */
async function factsText(orgId: string, place: NonNullable<Awaited<ReturnType<typeof placeOf>>>): Promise<string> {
  const { factsFor } = await import("./calling.ts");
  const about = await factsFor(orgId, { id: place.id, kind: place.kind, name: place.name, parent_name: place.parentName, grand_name: place.grandName }, place.developer);
  return about.facts;
}

/** What the agent would speak for a word now: the developer's spelling, the region's, or the word as written. */
function spokenOf(w: { written: string; said: string | null; regionSaid: string | null }): string {
  return (w.said ?? w.regionSaid ?? w.written).trim();
}

/**
 * Every word worth checking at a node: those set here or above, then the
 * names and places its facts use. A tower's own spelling wins over its
 * project's.
 */
export async function wordsAt(orgId: string, nodeId: string): Promise<{ place: Place; words: Word[] } | null> {
  const place = await placeOf(orgId, nodeId);
  if (!place) return null;
  const [rows, facts] = await Promise.all([rowsAbove(orgId, place.path), factsText(orgId, place)]);
  const region = place.region ? REGIONS[place.region].words : [];
  const regionSaid = (w: string) => region.find((s) => key(s.written) === key(w))?.said ?? null;
  const out = new Map<string, Word>();
  const here = rows.filter((r) => r.scope_node_id === place.id);
  const spelled = new Map<string, Row>();
  for (const r of rows) if (r.said && !spelled.has(key(r.written))) spelled.set(key(r.written), r);
  const add = (written: string, own: Row | undefined) => {
    const k = key(written);
    if (out.has(k)) return;
    const s = spelled.get(k);
    const word: Word = {
      written: own?.written ?? written,
      said: s?.said ?? null,
      saidAt: s ? (s.scope_node_id === place.id ? null : s.place) : null,
      regionSaid: regionSaid(written),
      heard: own?.heard ?? null,
      verdict: own?.verdict ?? "UNCHECKED",
      checkedAt: own?.checked_at ? own.checked_at.toISOString() : null,
      sampled: false,
    };
    word.sampled = !!own?.has_sample && own.sample_of === spokenOf(word);
    out.set(k, word);
  };
  for (const r of here) add(r.written, r);
  for (const r of rows) if (r.said) add(r.written, undefined);
  const project = place.kind === "PHASE" ? place.parentName : place.name;
  const tower = place.kind === "PHASE" ? place.name : null;
  for (const w of wordsToCheck({ names: [place.developer, project, tower, place.city], facts, max: SAYING_CAPS.perCheck * 2 })) add(w, undefined);
  return { place, words: [...out.values()] };
}

/**
 * How many times the voice said a word for this project and its towers since
 * a moment: every saying, not every word.
 */
async function checkedSince(orgId: string, projectPath: string, since: Date): Promise<number> {
  const [r] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pronunciation_checks c
    JOIN scope_nodes n ON n.id = c.scope_node_id
    WHERE c.org_id = ${orgId} AND n.path <@ ${projectPath}::ltree AND c.checked_at >= ${since}`);
  return r?.n ?? 0;
}

const istMidnight = (now: Date) => {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3_600_000);
};
const istMonthStart = (now: Date) => {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3_600_000);
};

export type Checked = { ok: true; checked: number; wrong: number; failed: number; left: number } | { ok: false; message: string };

/**
 * Say each word not yet checked (or whose spelling changed since) in the
 * agent's voice, hear it back and compare. Refused before anything is paid
 * when the node's day or month is used up.
 */
export async function checkWords(o: { orgId: string; userId: string; nodeId: string; now?: Date; only?: string[] }): Promise<Checked> {
  const now = o.now ?? new Date();
  const found = await wordsAt(o.orgId, o.nodeId);
  if (!found) return { ok: false, message: "That project or tower is not within your reach." };
  const due = found.words.filter((w) =>
    o.only?.length ? o.only.some((x) => key(x) === key(w.written)) : isDue(w),
  );
  if (!due.length) return { ok: true, checked: 0, wrong: 0, failed: 0, left: 0 };
  const project = projectPathOf(found.place.kind, found.place.path);
  const [today, month] = await Promise.all([checkedSince(o.orgId, project, istMidnight(now)), checkedSince(o.orgId, project, istMonthStart(now))]);
  if (month >= SAYING_CAPS.perProjectMonth) return { ok: false, message: "This project's words were checked as often as a month allows. Try again on the 1st." };
  if (today >= SAYING_CAPS.perProjectDay) return { ok: false, message: "This project's words were checked as often as a day allows. Try again tomorrow." };
  const room = Math.min(SAYING_CAPS.perCheck, SAYING_CAPS.perProjectDay - today, SAYING_CAPS.perProjectMonth - month);
  const batch = due.slice(0, room);
  const s = speech();
  let wrong = 0;
  let failed = 0;
  const one = async (w: Word) => {
    const spoken = spokenOf(w);
    // The same spelling heard for the project or another of its towers is the same answer.
    const [heardBefore] = await withTenant(o.orgId, (sql) => sql<{ sample: Buffer; heard: string | null; verdict: Verdict }[]>`
      SELECT p.sample, p.heard, p.verdict FROM pronunciations p
      JOIN scope_nodes n ON n.id = p.scope_node_id
      WHERE p.org_id = ${o.orgId} AND n.path <@ ${project}::ltree AND p.scope_node_id <> ${o.nodeId}
        AND p.sample IS NOT NULL AND p.sample_of = ${spoken} AND p.verdict IN ('RIGHT', 'WRONG')
      ORDER BY p.checked_at DESC NULLS LAST LIMIT 1`);
    if (heardBefore) {
      if (heardBefore.verdict === "WRONG") wrong++;
      await withTenant(o.orgId, (sql) => sql`
        INSERT INTO pronunciations (org_id, scope_node_id, written, heard, verdict, sample, sample_of, checked_at, updated_by)
        VALUES (${o.orgId}, ${o.nodeId}, ${w.written.trim()}, ${heardBefore.heard}, ${heardBefore.verdict}, ${heardBefore.sample}, ${spoken}, ${now}, ${o.userId})
        ON CONFLICT (org_id, scope_node_id, lower(btrim(written))) DO UPDATE SET
          heard = EXCLUDED.heard, verdict = EXCLUDED.verdict, sample = EXCLUDED.sample, sample_of = EXCLUDED.sample_of,
          checked_at = EXCLUDED.checked_at, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      return;
    }
    let cost = 0;
    const meant = w.said ?? w.regionSaid ?? (await s.spell(w.written)) ?? w.written;
    if (!w.said && !w.regionSaid) cost += w.written.length * SPELL_PAISE_PER_CHAR;
    const line = carrierLine(spoken);
    const wav = await s.say(line, "hi-IN");
    cost += line.length * SPEAK_PAISE_PER_CHAR;
    const heard = wav ? await s.hear(wav) : null;
    if (wav) cost += wavSeconds(wav) * HEAR_PAISE_PER_SECOND;
    const verdict: Verdict = !wav || heard === null ? "FAILED" : heardAsMeant(meant, heard) ? "RIGHT" : "WRONG";
    if (verdict === "WRONG") wrong++;
    if (verdict === "FAILED") failed++;
    await withTenant(o.orgId, async (sql) => {
      await sql`
      INSERT INTO pronunciation_checks (org_id, scope_node_id, verdict, cost_paise, checked_by, checked_at)
      VALUES (${o.orgId}, ${o.nodeId}, ${verdict}, ${Math.ceil(cost)}, ${o.userId}, ${now})`;
      await sql`
      INSERT INTO pronunciations (org_id, scope_node_id, written, heard, verdict, sample, sample_of, cost_paise, checked_at, updated_by)
      VALUES (${o.orgId}, ${o.nodeId}, ${w.written.trim()}, ${heard?.slice(0, 300) ?? null}, ${verdict},
              ${wav}, ${wav ? spoken : null}, ${Math.ceil(cost)}, ${now}, ${o.userId})
      ON CONFLICT (org_id, scope_node_id, lower(btrim(written))) DO UPDATE SET
        heard = EXCLUDED.heard, verdict = EXCLUDED.verdict,
        sample = coalesce(EXCLUDED.sample, pronunciations.sample),
        sample_of = coalesce(EXCLUDED.sample_of, pronunciations.sample_of),
        cost_paise = pronunciations.cost_paise + EXCLUDED.cost_paise,
        checked_at = EXCLUDED.checked_at, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    });
  };
  // Four at a time: forty words one after another kept a person waiting two minutes.
  for (let i = 0; i < batch.length; i += CHECK_AT_ONCE) await Promise.all(batch.slice(i, i + CHECK_AT_ONCE).map(one));
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "brain.words_checked",
    targetType: "scope_node",
    targetId: o.nodeId,
    metadata: { checked: batch.length, wrong, failed },
  });
  return { ok: true, checked: batch.length, wrong, failed, left: due.length - batch.length };
}

/**
 * Write how a word is really said at this node; an empty spelling puts it back
 * to the default. `keepSaid` is adding a word: an empty spelling then leaves
 * one already written for it alone, because "Add a word" with the box left
 * empty erased the spelling every call carried and said "Added".
 */
export async function saveSaying(o: { orgId: string; userId: string; nodeId: string; written: string; said: string; keepSaid?: boolean }): Promise<{ ok: true } | { ok: false; message: string }> {
  const problem = sayingProblem(o.written, o.said);
  if (problem) return { ok: false, message: problem };
  const said = o.said.trim() || null;
  const keep = !!o.keepSaid && said === null;
  await withTenant(o.orgId, (sql) => sql`
    INSERT INTO pronunciations (org_id, scope_node_id, written, said, updated_by)
    VALUES (${o.orgId}, ${o.nodeId}, ${o.written.trim()}, ${said}, ${o.userId})
    ON CONFLICT (org_id, scope_node_id, lower(btrim(written))) DO UPDATE SET
      said = CASE WHEN ${keep} THEN pronunciations.said ELSE EXCLUDED.said END,
      verdict = CASE WHEN NOT ${keep} AND pronunciations.said IS DISTINCT FROM EXCLUDED.said THEN 'UNCHECKED' ELSE pronunciations.verdict END,
      updated_by = EXCLUDED.updated_by, updated_at = now()`);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "brain.word_said",
    targetType: "scope_node",
    targetId: o.nodeId,
    metadata: { set: said !== null },
  });
  return { ok: true };
}

export type Sample = { ok: true; wav: Buffer } | { ok: false; status: 404 | 409 | 429 | 502; message: string };

/**
 * The agent saying a word as it would now. Kept on the row, so a second press
 * costs nothing. A word with no sample of its current spelling is checked
 * (said and heard back, under the same caps as a check), and only somebody
 * who may check words gets that.
 */
export async function sampleOf(o: { orgId: string; userId: string; nodeId: string; written: string; mayCheck: boolean }): Promise<Sample> {
  const kept = async () => {
    const found = await wordsAt(o.orgId, o.nodeId);
    const w = found?.words.find((x) => key(x.written) === key(o.written));
    if (!w) return { w: null, wav: null };
    const [row] = await withTenant(o.orgId, (sql) => sql<{ sample: Buffer | null; sample_of: string | null }[]>`
      SELECT sample, sample_of FROM pronunciations
      WHERE org_id = ${o.orgId} AND scope_node_id = ${o.nodeId} AND lower(btrim(written)) = ${key(w.written)}`);
    return { w, wav: row?.sample && row.sample_of === spokenOf(w) ? row.sample : null };
  };
  const first = await kept();
  if (!first.w) return { ok: false, status: 404, message: "That word is not on this list." };
  if (first.wav) return { ok: true, wav: first.wav };
  if (!o.mayCheck) return { ok: false, status: 409, message: "Not checked yet." };
  const done = await checkWords({ orgId: o.orgId, userId: o.userId, nodeId: o.nodeId, only: [first.w.written] });
  if (!done.ok) return { ok: false, status: 429, message: done.message };
  const again = await kept();
  return again.wav ? { ok: true, wav: again.wav } : { ok: false, status: 502, message: "The voice did not answer. Try again in a minute." };
}

/**
 * The `say_words` a call about this node carries: the developer's spellings
 * set here or above, then the region's words the facts use.
 */
export async function wordsForCall(o: {
  orgId: string; nodePath: string; city: string | null; facts: string;
  /**
   * Names the agent will say that no spelling here covers: the buyer's first
   * name and the developer's. Each is put into Devanagari by Sarvam's
   * transliteration, raced and remembered; one that does not come back in
   * time is left out. On 9 October 2026 the voice said "Nannhe" as "Naani ji"
   * and "BillBay" as "Dil Desh".
   */
  names?: readonly string[];
}): Promise<string> {
  const rows = await rowsAbove(o.orgId, o.nodePath).catch(() => [] as Row[]);
  const own: Saying[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.said || seen.has(key(r.written))) continue;
    seen.add(key(r.written));
    own.push({ written: r.written, said: r.said });
  }
  const names = [...new Set((o.names ?? []).map((n) => n.trim()).filter((n) => /^[A-Za-z][A-Za-z .'-]{1,39}$/.test(n) && !seen.has(key(n))))].slice(0, 3);
  const spelt = await Promise.all(names.map(spellName));
  names.forEach((n, i) => { const s = spelt[i]; if (s) own.push({ written: n, said: s }); });
  return wordsToSay({ own, region: regionFor(o.city), context: `${o.facts}\n${o.city ?? ""}` });
}

/** A name's Devanagari spelling, kept for the life of the process. */
const spelling = new Map<string, string>();
const SPELL_WAIT_MS = 2_500;

async function spellName(name: string): Promise<string | null> {
  const k = key(name);
  const known = spelling.get(k);
  if (known) return known;
  const said = await Promise.race([
    speech().spell(name).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), SPELL_WAIT_MS)),
  ]);
  const clean = said && /[ऀ-ॿ]/.test(said) ? said.trim() : null;
  if (clean) spelling.set(k, clean);
  return clean;
}
