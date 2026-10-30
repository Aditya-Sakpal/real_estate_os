import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listOrgRoles } from "@/lib/rbac";
import { Ask, ArrowUpRight, Check } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import { listConnections } from "@/lib/connect";
import { HEALTH_PILL, PROVIDERS } from "@/lib/connect-rules";
import { listTeam, policyAt } from "@/lib/calling";
import { whatsappConnected } from "@/lib/wa-numbers";
import { actionsOn } from "@/lib/ask-actions";
import { setJimmyActionsAction } from "@/app/actions/ask";
import { ConfirmAction } from "@/components/ConfirmAction";
import { settingsGroups } from "./items";

type Pill = { text: string; tone: "ok" | "warn" | "risk" | "quiet" | "blue" };
type Need = { text: string; href: string; risk?: boolean };

/**
 * Settings overview: what needs a person, the organisation beside it, and
 * where the settings that change from day to day stand. The list of every
 * setting is the frame beside it, so it is not repeated here.
 */
export default async function SettingsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");

  const allowed = ["org:read", "org:manage", "role:read", "role:manage",
                   "integration:manage", "project:read", "project:create",
                   "campaign:publish", "campaign.budget:manage", "billing:read", "audit:read"];
  if (!allowed.some((p) => viewer.authz.can(p))) redirect("/dashboard");

  const groups = settingsGroups(viewer);
  const has = (key: string) => groups.some((g) => g.items.some((i) => i.key === key));
  const orgId = viewer.state.org.id;

  const [roles, connections, calling, team, jimmyActs, waOn] = await Promise.all([
    has("roles") ? listOrgRoles(orgId) : Promise.resolve([]),
    has("connections") ? listConnections(orgId) : Promise.resolve([]),
    has("calling") ? policyAt(orgId, null) : Promise.resolve(null),
    has("calling") ? listTeam(orgId) : Promise.resolve([]),
    viewer.authz.can("org:manage") ? actionsOn(orgId) : Promise.resolve(null),
    has("connections") ? whatsappConnected(orgId) : Promise.resolve(true),
  ]);

  const onDuty = team.filter((p) => p.onDuty).length;
  const edited = roles.filter((r) => r.source !== "TEMPLATE").length;

  // Where each tile stands, in a pill a person reads at a glance.
  const pills: Record<string, Pill[]> = {};
  if (has("roles"))
    pills.roles = [{ text: `${roles.length} roles`, tone: "quiet" },
      ...(edited ? [{ text: `${edited} changed`, tone: "blue" as const }] : [])];
  if (calling)
    pills.calling = [
      { text: team.length ? `${onDuty} of ${team.length} on duty` : "No sales team", tone: team.length ? "ok" : "warn" },
      { text: calling.consentRequired ? "Consent required" : "No consent check", tone: "quiet" },
    ];
  if (has("connections")) {
    pills.connections = PROVIDERS.map((p) => {
      const c = connections.find((x) => x.provider === p.key);
      const h = c ? HEALTH_PILL[c.health] : HEALTH_PILL.off;
      return { text: `${p.label}: ${h.text.toLowerCase()}`, tone: h.tone };
    });
    pills.connections.push({ text: waOn ? "WhatsApp connected" : "WhatsApp: not connected", tone: waOn ? "ok" : "quiet" });
  }

  // What needs a person, most serious first. Each one opens the screen that fixes it.
  const needs: Need[] = [];
  for (const p of PROVIDERS) {
    const c = connections.find((x) => x.provider === p.key);
    if (c && c.health !== "ok" && c.health !== "off")
      needs.push({ text: `${p.label}: ${HEALTH_PILL[c.health].text.toLowerCase()}`,
        href: `/dashboard/settings/connections/${p.key.toLowerCase()}`, risk: HEALTH_PILL[c.health].tone === "risk" });
  }
  if (has("connections") && !waOn)
    needs.push({ text: "Connect WhatsApp to message your buyers", href: "/dashboard/settings/connections/whatsapp" });
  if (calling && team.length === 0)
    needs.push({ text: "Add your sales team, so ready buyers reach a person", href: "/dashboard/settings/calling" });
  if (calling && team.length > 0 && onDuty === 0)
    needs.push({ text: "Nobody on the sales team is on duty", href: "/dashboard/settings/calling", risk: true });
  needs.sort((a, b) => Number(!!b.risk) - Number(!!a.risk));

  // The screens whose state is worth seeing without opening them.
  const glance = groups.flatMap((g) => g.items).filter((i) => pills[i.key]?.length);

  const showNeeds = viewer.authz.can("org:manage") || has("connections");

  return (
    <>
      <PageHead
        title={
          <>
            Settings for <span className="em">{viewer.state.org.displayName}</span>
          </>
        }
      />

      <div className={`sethome__top${showNeeds ? "" : " sethome__top--solo"}`}>
        <section className="card sethome__org" aria-labelledby="org-title">
          <div className="card__head">
            <h2 id="org-title">This organisation</h2>
          </div>
          <div className="facts">
            <Fact k="Legal name" v={viewer.state.org.legalName} />
            <Fact k="PAN" v={viewer.state.org.pan} />
            <Fact k="GSTIN" v={viewer.state.org.gstin ?? "Not provided"} />
            <Fact k="People" v={String(viewer.state.memberCount)} />
          </div>
          <div className="sethome__org-foot">
            {has("entities") && <Link href="/dashboard/settings/entities">Legal entities</Link>}
            <Link href="/dashboard/team">Team</Link>
          </div>
        </section>

        {showNeeds && (
          <section className="sethome__needs" aria-labelledby="needs-title" data-settings-needs>
            <h2 id="needs-title">Needs you</h2>
            {needs.length > 0 ? (
              <>
                <p className="sub">
                  {needs.length === 1 ? "One thing to finish." : `${needs.length} things to finish.`}
                </p>
                <ul>
                  {needs.slice(0, 4).map((n) => (
                    <li key={n.text}>
                      <Link href={n.href} className="sethome__need">
                        <span className={`sethome__need-dot${n.risk ? " sethome__need-dot--risk" : ""}`} />
                        <span>{n.text}</span>
                        <ArrowUpRight size={14} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="sethome__calm">
                <Check size={15} /> Everything is set up.
              </p>
            )}
          </section>
        )}
      </div>

      <section className="card" aria-labelledby="glance-title">
        <div className="card__head">
          <h2 id="glance-title">At a glance</h2>
        </div>
        <div className="glance">
          {glance.map((item) => (
            <Link key={item.key} href={item.href} className="glance__cell" data-settings-tile={item.key}>
              <span className="glance__name">
                {item.label}
                <ArrowUpRight size={13} />
              </span>
              <span className="glance__pills">
                {pills[item.key]!.map((p) => (
                  <span key={p.text} className={`pill pill--${p.tone}`}>
                    {p.tone !== "quiet" && <span className="pill__dot" />}
                    {p.text}
                  </span>
                ))}
              </span>
            </Link>
          ))}

          {/* Ask Jimmy is a switch, not a screen, so its cell holds the switch. */}
          {jimmyActs !== null && (
            <div className="glance__cell" data-jimmy-actions>
              <span className="glance__name">
                <Ask size={14} /> Ask Jimmy
              </span>
              <span className="glance__pills">
                <span className={`pill ${jimmyActs ? "pill--ok" : "pill--quiet"}`}>
                  <span className="pill__dot" />
                  {jimmyActs ? "Can take actions" : "Answers only"}
                </span>
                <span style={{ marginLeft: "auto" }}>
                  {/* Keyed on the state, so the question closes once the switch has moved. */}
                  <ConfirmAction
                    key={String(jimmyActs)}
                    label={jimmyActs ? "Switch off" : "Switch on"}
                    title={jimmyActs ? "Stop Jimmy taking actions?" : "Let Jimmy take actions?"}
                    body={
                      <p>
                        {jimmyActs
                          ? "Jimmy will only answer questions. Nobody will be able to ask it to call a lead, make a post or change anything."
                          : "Everyone in the organisation will be able to ask Jimmy to call a lead, make a post and more. Each action waits for the person to confirm it, and nobody can do more than their role allows."}
                      </p>
                    }
                    confirmLabel={jimmyActs ? "Answers only" : "Let Jimmy take actions"}
                    action={setJimmyActionsAction}
                    fields={{ on: jimmyActs ? "false" : "true" }}
                    tone={jimmyActs ? "ghost" : "ink"}
                    testId="jimmy-actions"
                  />
                </span>
              </span>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="fact">
      <div className="fact__k">{k}</div>
      <div className="fact__v">{v}</div>
    </div>
  );
}
