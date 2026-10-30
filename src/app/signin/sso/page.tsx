import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { ticketOrg } from "@/lib/sso";
import { ACTIVE_ORG_COOKIE } from "@/lib/onboarding";
import { Mark } from "@/components/icons";
import { AutoSubmit } from "./AutoSubmit";
import "../signin.css";

/**
 * The last step of a company sign-in: spend the ticket the ACS address
 * issued, in the company it was issued for.
 */
async function finish(formData: FormData) {
  "use server";
  const ticket = String(formData.get("t") ?? "");
  const test = formData.get("test") === "1";
  const orgId = await ticketOrg(ticket);
  if (!orgId) redirect("/signin?error=SSO_EXPIRED");
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  await signIn("sso", { ticket, redirectTo: test ? "/dashboard/settings/sso?tested=1" : "/" });
}

export default async function SsoFinish({ searchParams }: { searchParams: Promise<{ t?: string; test?: string }> }) {
  const { t, test } = await searchParams;
  if (!t) redirect("/signin");
  return (
    <div className="auth">
      <main className="auth__card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <span className="brand__glyph"><Mark /></span>
          <span className="brand__name">Sales Desk</span>
        </div>
        <h1>
          Signing you <span className="em">in</span>
        </h1>
        <AutoSubmit action={finish} ticket={t} test={test === "1"} />
      </main>
    </div>
  );
}
