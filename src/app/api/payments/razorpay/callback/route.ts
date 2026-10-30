import { NextResponse, type NextRequest } from "next/server";
import { flash } from "@/lib/flash";
import { getViewer } from "@/lib/console";
import { payments, readPayConnect, savePaymentAccount } from "@/lib/payments";

/**
 * Where Razorpay sends a person back. The state is ours, unexpired, started
 * in this browser by this person and for the organisation they are in now,
 * before the code is exchanged for the account's token.
 */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/signin", request.url));
  const page = new URL("/dashboard/settings/payments", request.url);
  const finish = (name: "error" | "done", message: string) => {
    for (const [k, v] of new URLSearchParams(flash(name, message))) page.searchParams.set(k, v);
    const response = NextResponse.redirect(page);
    response.cookies.delete({ name: "est_pay", path: "/api/payments" });
    return response;
  };
  if (!viewer.authz.can("integration:manage")) return finish("error", "You cannot connect accounts here.");
  const q = new URL(request.url).searchParams;
  const state = readPayConnect(q.get("state"), { nonce: request.cookies.get("est_pay")?.value ?? null, userId: viewer.userId });
  if (!state) return finish("error", "That sign-in did not start here, or took too long. Connect again.");
  if (state.o !== viewer.state.org.id) return finish("error", "You switched organisation while connecting. Connect again from here.");
  const code = q.get("code");
  if (!code) return finish("error", "Razorpay did not connect the account.");
  try {
    const tokens = await payments().exchange(code, `${process.env.CONNECT_BASE_URL ?? new URL(request.url).origin}/api/payments/razorpay/callback`);
    const saved = await savePaymentAccount({ orgId: viewer.state.org.id, userId: viewer.userId, tokens });
    return saved.ok ? finish("done", "Razorpay is connected.") : finish("error", saved.message);
  } catch {
    return finish("error", "Razorpay did not connect the account. Try again.");
  }
}
