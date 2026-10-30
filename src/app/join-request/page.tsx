import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { signOutAction } from "@/app/actions/auth";
import { getUserOrgState } from "@/lib/onboarding";
import { Mark } from "@/components/icons";

export default async function JoinRequest() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const state = await getUserOrgState(session.user.id);
  if (state.kind === "MEMBER") redirect("/dashboard");
  if (state.kind === "NO_ORG") redirect("/onboarding");

  return (
    <div className="auth">
    <main className="auth__card">
      <div className="brand" style={{ marginBottom: 22 }}>
        <span className="brand__glyph"><Mark /></span>
        <span className="brand__name">Sales Desk</span>
      </div>

      <h1>
        Request <span className="em">sent</span> to {state.orgName}
      </h1>
      <p className="sub" style={{ marginBottom: 22 }}>
        An admin at {state.orgName} needs to approve you and assign your role.
        You will get an email the moment that happens.
      </p>

      <div className="note note--info">
        <strong>Why an admin decides this</strong>
        Roles are scoped to projects, not to the whole organisation. Only
        someone who knows which projects you work on can place you correctly.
      </div>

      <form action={signOutAction}>
        <button type="submit" className="btn btn--ghost">Sign out</button>
      </form>
    </main>
    </div>
  );
}
