/**
 * Ask Jimmy's working memory: a chat's last six exchanges and its running
 * summary, kept in Redis so a question reads them in one round trip.
 *
 * Postgres stays the record. The chat list, the screen, the 30-day expiry and
 * the cards all read `ask_threads`, `ask_messages` and `ask_actions`; this is a
 * copy shaped for the models, and losing it loses nothing but the summary.
 * Three rules hold it together:
 *
 *   1. A key is only read after Postgres has proved the chat is the person's.
 *      Redis has no row-level security, so the key carries the org, the person
 *      and the chat, and every caller gets there through `withPerson()` first.
 *   2. It can never stop a question. Every command is timed by a race; a store
 *      that is down, slow or evicted a chat is an empty memory, and the last
 *      six exchanges are read from Postgres instead (and written back).
 *   3. It forgets when Postgres does. Every key lives `CHAT_DAYS` from its last
 *      write, the age `ask_expire()` removes a chat at, and deleting a chat
 *      deletes its keys.
 *
 * `REDIS_URL` switches it on; without one the memory is Postgres alone and
 * there is no summary. `useMemoryStore()` is the seam the checks use.
 */

import { createClient } from "redis";
import { CHAT_DAYS, HISTORY_EXCHANGES } from "./ask-rules.ts";

export type MemoryTurn = { role: "PERSON" | "JIMMY"; body: string; actionId: string | null };

export type ChatKey = { orgId: string; userId: string; threadId: string };

export type MemoryStore = {
  read(key: ChatKey): Promise<{ turns: MemoryTurn[]; summary: string | null }>;
  append(key: ChatKey, turns: MemoryTurn[]): Promise<void>;
  setSummary(key: ChatKey, summary: string): Promise<void>;
  forget(key: ChatKey): Promise<void>;
};

/** Six exchanges, a question and an answer each. */
export const MEMORY_TURNS = HISTORY_EXCHANGES * 2;
const TTL_SECONDS = CHAT_DAYS * 86_400;
/** Longer than this and the question goes on without it. */
const COMMAND_MS = 1500;
const BODY_CHARS = 1500;

const turnsKey = (k: ChatKey) => `ask:${k.orgId}:${k.userId}:${k.threadId}:turns`;
const summaryKey = (k: ChatKey) => `ask:${k.orgId}:${k.userId}:${k.threadId}:summary`;

function raced<T>(p: Promise<T>, ms = COMMAND_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the memory store took longer than ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** A stored turn read back defensively: anything odd is dropped, not trusted. */
function readTurn(raw: string): MemoryTurn | null {
  try {
    const t = JSON.parse(raw) as Partial<MemoryTurn>;
    if ((t.role !== "PERSON" && t.role !== "JIMMY") || typeof t.body !== "string") return null;
    return { role: t.role, body: t.body, actionId: typeof t.actionId === "string" ? t.actionId : null };
  } catch {
    return null;
  }
}

// One client per process. The dev server reloads modules, so it lives on
// globalThis, or every edit would open another connection.
function connectTo(url: string) {
  return createClient({
    url,
    socket: { connectTimeout: 3000, reconnectStrategy: (tries: number) => (tries > 5 ? false : Math.min(tries * 200, 2000)) },
  });
}
type Client = ReturnType<typeof connectTo>;
const slot = globalThis as unknown as { __askMemory?: { url: string; client: Client; ready: Promise<unknown> } };

async function client(): Promise<Client> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new Error("REDIS_URL is not set.");
  let held = slot.__askMemory;
  if (!held || held.url !== url || !held.client.isOpen) {
    const c = connectTo(url);
    c.on("error", (e: Error) => console.warn("ask memory:", e.message));
    held = { url, client: c, ready: c.connect() };
    slot.__askMemory = held;
    held.ready.catch(() => {
      if (slot.__askMemory === held) slot.__askMemory = undefined;
    });
  }
  await raced(held.ready, 4000);
  return held.client;
}

const redisStore: MemoryStore = {
  async read(k) {
    const c = await client();
    const [raw, summary] = await raced(Promise.all([c.lRange(turnsKey(k), 0, -1), c.get(summaryKey(k))]));
    return {
      turns: raw.map(readTurn).filter((t): t is MemoryTurn => t !== null).slice(-MEMORY_TURNS),
      summary: typeof summary === "string" && summary.trim() ? summary : null,
    };
  },
  async append(k, turns) {
    if (!turns.length) return;
    const c = await client();
    const items = turns.map((t) => JSON.stringify({ ...t, body: t.body.slice(0, BODY_CHARS) }));
    await raced(
      c
        .multi()
        .rPush(turnsKey(k), items)
        .lTrim(turnsKey(k), -MEMORY_TURNS, -1)
        .expire(turnsKey(k), TTL_SECONDS)
        .expire(summaryKey(k), TTL_SECONDS)
        .exec(),
    );
  },
  async setSummary(k, summary) {
    const c = await client();
    await raced(c.multi().set(summaryKey(k), summary).expire(summaryKey(k), TTL_SECONDS).exec());
  },
  async forget(k) {
    const c = await client();
    await raced(c.del([turnsKey(k), summaryKey(k)]));
  },
};

let injected: MemoryStore | null = null;

/** For checks: route the memory through `store` until `restore()`. */
export function useMemoryStore(store: MemoryStore): { restore(): void } {
  injected = store;
  return { restore: () => void (injected = null) };
}

/** The store in use, or null when there is none. */
export function memoryStore(): MemoryStore | null {
  if (injected) return injected;
  return process.env.REDIS_URL?.trim() ? redisStore : null;
}

// The four operations as a question uses them: a failure is logged and read
// as "nothing remembered", never thrown.

export async function recall(k: ChatKey): Promise<{ turns: MemoryTurn[]; summary: string | null } | null> {
  const store = memoryStore();
  if (!store) return null;
  try {
    return await store.read(k);
  } catch (e) {
    console.warn("ask memory: read failed,", (e as Error).message);
    return null;
  }
}

export async function remember(k: ChatKey, turns: MemoryTurn[]): Promise<void> {
  try {
    await memoryStore()?.append(k, turns);
  } catch (e) {
    console.warn("ask memory: write failed,", (e as Error).message);
  }
}

export async function keepSummary(k: ChatKey, summary: string): Promise<void> {
  try {
    await memoryStore()?.setSummary(k, summary);
  } catch (e) {
    console.warn("ask memory: summary write failed,", (e as Error).message);
  }
}

export async function forgetChat(k: ChatKey): Promise<void> {
  try {
    await memoryStore()?.forget(k);
  } catch (e) {
    console.warn("ask memory: forget failed,", (e as Error).message);
  }
}
