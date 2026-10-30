import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrgState, homeFor } from "@/lib/onboarding";

/**
 * The only router the onboarding flow needs: where a signed-in person belongs
 * depends entirely on whether they hold a membership, have a request pending,
 * or are the first person here from their company.
 */
export default async function Home() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const state = await getUserOrgState(session.user.id);

  if (state.kind === "MEMBER") redirect(homeFor(state.orgType));
  if (state.kind === "PENDING_JOIN") redirect("/join-request");
  redirect("/onboarding");
}
