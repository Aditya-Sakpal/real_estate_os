import { getViewer } from "@/lib/console";
import { checkInByScan } from "@/lib/checkin";
import { readPosition } from "@/lib/checkin-rules";

/**
 * The scanner's queue arriving: up to twenty scans, each judged by
 * `checkInByScan()` as if it were made now, except that the time and
 * position are the ones the phone recorded when it scanned. An answer comes
 * back for every scan that was judged, so the phone forgets exactly those.
 *
 * A route rather than a server action, because the phone calls it from its
 * own queue whenever the signal comes back. The origin is compared because a
 * route, unlike a server action, gets no check of its own.
 */
export const dynamic = "force-dynamic";

const MAX_SCANS = 20;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });

  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  if (!viewer.authz.can("visit:confirm")) return new Response("Forbidden", { status: 403 });

  const body = (await request.json().catch(() => null)) as { scans?: unknown } | null;
  const scans = Array.isArray(body?.scans) ? body.scans.slice(0, MAX_SCANS) : [];
  const receivedAt = new Date().toISOString();

  const results: Record<string, unknown>[] = [];
  for (const raw of scans as Record<string, unknown>[]) {
    const id = typeof raw?.id === "string" ? raw.id.slice(0, 64) : "";
    if (!id) continue;
    const payload = typeof raw.payload === "string" ? raw.payload.slice(0, 120) : "";
    const scannedAt = typeof raw.scannedAt === "string" && Number.isFinite(Date.parse(raw.scannedAt)) ? raw.scannedAt : receivedAt;
    const r = await checkInByScan({
      orgId: viewer.state.org.id,
      userId: viewer.userId,
      authz: viewer.authz,
      payload,
      scannedAt,
      position: readPosition(raw.position as never),
      receivedAt,
    });
    results.push(r.ok ? { id, ok: true, buyer: r.buyer, at: r.at, flags: r.flags } : { id, ok: false, code: r.code, message: r.message });
  }
  return Response.json({ results });
}
