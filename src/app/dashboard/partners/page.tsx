import { redirect } from "next/navigation";
import { sellsForOthers } from "@/lib/mandate-rules";
import { getViewer } from "@/lib/console";
import { loadDesk } from "@/lib/partners";
import { loadMandates, mandateProjects } from "@/lib/mandates";
import { firmPeople } from "@/lib/grant-access";
import { PartnerDesk, type DeskData, type DeskView } from "./PartnerDesk";

/**
 * The partner desk: firms, the buyers they registered, and what they are owed.
 *
 * Real rows only: until the tenant empanels a firm the desk is empty, with
 * the actions that start real work (empanelling a firm) live. The views
 * are one address with a `view` parameter. Mandate firms are always real:
 * they are the developer's own mandates, and appointing one is its own key.
 *
 * Either key opens the section. A payout approver holds `payout:read` and no
 * partner key at all, and sees the payouts and nothing else; a relationship
 * manager without `payout:read` sees firms and registrations and never an
 * amount owed. Every read is filtered to where the viewer holds each key.
 *
 * A mandate firm working through its mandate sees its own desk: the partners
 * it empanelled on the mandated projects, their buyers and what it owes them.
 * The developer's own partners and its mandates are not on it.
 */
export default async function PartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  // A channel partner is the partner here: its developers are in Developers.
  if (viewer.orgType === "CHANNEL_PARTNER") redirect("/dashboard/developers");
  const partners = viewer.authz.can("partner:read");
  const payouts = viewer.authz.can("payout:read");
  const mandates = viewer.authz.can("mandate:manage");
  if (!partners && !payouts && !mandates) redirect("/dashboard");

  const views: DeskView[] = [
    ...(partners ? (["firms", "buyers"] as const) : []),
    ...(payouts ? (["payouts"] as const) : []),
    ...((partners || mandates) && !viewer.via && !sellsForOthers(viewer.orgType) ? (["mandates"] as const) : []),
  ];
  const asked = (await searchParams).view as DeskView | undefined;
  const view = asked && views.includes(asked) ? asked : views[0];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  const orgId = viewer.state.org.id;
  const manageScopes = viewer.authz.scopesFor("mandate:manage");
  const [loaded, mandateRows, projects] = await Promise.all([
    loadDesk({
      orgId,
      partnerScopes: viewer.authz.scopesFor("partner:read"),
      payoutScopes: viewer.authz.scopesFor("payout:read"),
      unmaskScopes: viewer.authz.scopesFor("lead.phone:unmask"),
      desk: viewer.desk,
      people: viewer.via ? await firmPeople(viewer.via.firmOrgId) : undefined,
    }),
    viewer.via ? [] : loadMandates({ orgId, scopes: [...new Set([...viewer.authz.scopesFor("partner:read"), ...manageScopes])] }),
    viewer.via ? [] : mandateProjects({ orgId, scopes: manageScopes }),
  ]);

  // Never invented partners: a client's console holds only its own data.
  const desk: DeskData = { ...loaded, real: true };

  const a = viewer.authz;
  return (
    <PartnerDesk
      today={today}
      view={view}
      views={views}
      desk={{ ...desk, mandates: mandateRows, mandateProjects: projects }}
      via={viewer.via ? { firm: viewer.via.firmName, developer: viewer.state.org.displayName } : undefined}
      can={{
        approve: a.can("payout:approve"),
        unmask: a.can("lead.phone:unmask"),
        empanel: a.can("partner:empanel"),
        suspend: a.can("partner:suspend"),
        register: a.can("partner:register"),
        pay: a.can("payout:pay"),
        schedule: a.can("visit:schedule"),
        settings: a.can("org:manage") && !viewer.via,
        mandate: a.can("mandate:manage") && !viewer.via && !sellsForOthers(viewer.orgType),
      }}
    />
  );
}
