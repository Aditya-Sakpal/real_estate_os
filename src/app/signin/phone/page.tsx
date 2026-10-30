import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Mark } from "@/components/icons";
import { PhoneForm } from "./PhoneForm";
import "../signin.css";

/** A channel partner's people sign in with their phone and a code on WhatsApp. */
export default async function PhoneSignIn() {
  const session = await auth();
  if (session?.user?.id) redirect("/");

  return (
    <div className="auth">
      <main className="auth__card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <span className="brand__glyph"><Mark /></span>
          <span className="brand__name">Sales Desk</span>
        </div>
        <h1>
          Sign in with your <span className="em">phone</span>
        </h1>
        <p className="sub" style={{ marginBottom: 20 }}>
          For channel partners. We send a code on WhatsApp.
        </p>
        <PhoneForm />
        <p className="phonesign__back">
          <Link href="/signin">Use Google or Microsoft instead</Link>
        </p>
      </main>
    </div>
  );
}
