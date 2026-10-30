import { startReceptionist } from "@/lib/inbound-calls";

/**
 * Sarvam's on-start request for the AI receptionist: who is ringing which
 * of our numbers. Answers with the variables the agent reads, both as
 * `agent_variables` (the shape Sarvam's on-start output names) and flat, so
 * either way the agent's response template is written reads them.
 *
 * The address carries an HMAC (`?t=`), because Sarvam signs nothing. A
 * request that does not prove itself is told nothing.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const started = await startReceptionist({ token: url.searchParams.get("t"), body, query: { n: url.searchParams.get("n") } }).catch((e) => {
    console.warn("receptionist: start failed,", (e as Error).message);
    return null;
  });
  if (!started) return Response.json({ agent_variables: { answer_mode: "general" }, answer_mode: "general" });
  return Response.json({ agent_variables: started.variables, ...started.variables });
}
