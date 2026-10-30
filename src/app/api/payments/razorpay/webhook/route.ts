import { after } from "next/server";
import { receivePaymentWebhook } from "@/lib/quotes";

/**
 * Razorpay telling us about a developer's token link or a refund on it.
 * Proved by its HMAC over the raw bytes, stored once per
 * `x-razorpay-event-id`, and answered at once; the quote, the block, the
 * refund and the lead move after the answer. The account the event names
 * decides the tenant, through the one read across tenants.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const raw = await request.text();
  const answer = await receivePaymentWebhook(raw, request.headers.get("x-razorpay-signature"), request.headers.get("x-razorpay-event-id"));
  if (answer.status === 403) return new Response("Forbidden", { status: 403 });
  if (answer.status === 400) return new Response("Bad request", { status: 400 });
  if (answer.work) after(answer.work);
  return Response.json({ ok: true });
}
