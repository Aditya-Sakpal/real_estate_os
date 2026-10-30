import { after } from "next/server";
import { ingestRazorpay } from "@/lib/billing-pay";
import { afterPlanPaidQuietly } from "@/lib/plan-after";

/**
 * Razorpay's webhook: a top-up's or a plan's payment captured or failed.
 *
 * The body is read as text and never re-serialised, because the signature is
 * over the exact bytes Razorpay sent. It is stored before it is acted on,
 * once per `x-razorpay-event-id`, and settling is idempotent, so a retry, or
 * the same payment arriving after Checkout already confirmed it, credits
 * nothing twice. Anything unsigned is refused before a row is read. A plan
 * paid here gets its calling number after the answer has gone.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const out = await ingestRazorpay(raw, request.headers.get("x-razorpay-signature"), request.headers.get("x-razorpay-event-id"));
  if (out.orgId && out.plan) {
    const orgId = out.orgId;
    const plan = out.plan;
    after(() => afterPlanPaidQuietly(orgId, plan));
  }
  return new Response(out.status === 200 ? "ok" : out.note, { status: out.status });
}
