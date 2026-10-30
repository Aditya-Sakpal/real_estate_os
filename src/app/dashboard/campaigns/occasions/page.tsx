import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listOccasions } from "@/lib/post";
import OccasionForm from "./OccasionForm";
import "./occasions.css";

/**
 * Which occasions this developer observes.
 *
 * Nothing here is inferred, and that is the whole screen. Posting every Hindu
 * festival on behalf of a Muslim or Jain developer is the kind of mistake
 * that ends an account, and there is no signal anywhere in this product that
 * could honestly be read as permission.
 *
 * Grouped by year, with the buying occasions marked, because those are the
 * two facts a marketing head is actually choosing between: whether they greet
 * on it, and whether an offer may ride along.
 *
 * A date nobody has verified is shown and cannot be ticked. The hard stop on
 * a festival offer is computed from that date, so a lunar date that is one
 * day out publishes "no floor rise until Diwali" the day after Diwali, which
 * is a false offer with our own calendar as the cause.
 */
export default async function OccasionsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");

  const mayWrite = viewer.authz.can("campaign:create");
  const now = new Date();
  const occasions = await listOccasions(
    viewer.state.org.id,
    now,
    new Date(now.getTime() + 2 * 366 * 86_400_000),
  );

  // A festival marked once covers every year shown, so it counts once.
  const chosen = new Set(occasions.filter((o) => o.optedIn).map((o) => o.key)).size;

  return (
    <>
      <OccasionForm
        meta={
          chosen === 0
            ? "Nothing is marked, so no scheduled post will mention a festival."
            : `${chosen} marked.`
        }
        occasions={occasions.map((o) => ({
          key: o.key,
          name: o.name,
          onDate: o.onDate,
          kind: o.kind,
          regions: o.regions,
          verified: o.verified,
          optedIn: o.optedIn,
        }))}
        mayWrite={mayWrite}
      />
    </>
  );
}
