import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Mark } from "@/components/icons";
import { SESSION_COOKIE, verify } from "@/lib/operator";
import { SignInForm } from "./SignInForm";

export default async function AdminSignIn({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (verify((await cookies()).get(SESSION_COOKIE)?.value, "session")) redirect("/");
  const { e } = await searchParams;
  return (
    <main className="adm-signin">
      <div className="adm-signin-card">
        <div className="brand adm-signin-brand">
          <span className="brand__glyph">
            <Mark />
          </span>
          <span className="brand__name">
            Sales Desk <span className="adm-brand-tag">Admin</span>
          </span>
        </div>
        <h1>
          Sign in to the <span className="em">console</span>
        </h1>
        <p className="adm-signin-sub">For Sales Desk staff. We email you a link that signs you in.</p>
        {e === "link" && <p className="adm-note-line adm-note-line--risk">That link has expired or is not valid. Ask for a new one.</p>}
        <SignInForm />
      </div>
    </main>
  );
}
