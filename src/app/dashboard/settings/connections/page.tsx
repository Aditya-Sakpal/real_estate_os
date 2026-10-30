import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listConnections, providerReady, type ConnectionView } from "@/lib/connect";
import {
  accountKindLabel,
  HEALTH_PILL,
  PROVIDERS,
  providerSlug,
  showRupees,
  type Provider,
} from "@/lib/connect-rules";
import { PageHead } from "@/components/shell/PageHead";
import { ProviderMark } from "@/components/ProviderMark";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { ArrowUpRight } from "@/components/icons";
import { uploadSummary, type UploadSummary } from "@/lib/attribution";
import { rupees } from "@/lib/lead-rules";
import { ValuesForm } from "./Outcomes";
import { CrmCard } from "./CrmCard";
import { crmHealth } from "@/lib/crm-sync";
import { WhatsAppCard } from "./WhatsAppCard";
import { whatsappSummary } from "@/lib/wa-numbers";
import { SmsCard } from "./SmsCard";
import { smsSummary } from "@/lib/sms";
import { PortalsCard } from "./PortalsCard";
import { portalSummary } from "@/lib/portal-leads";
import "./outcomes.css";

/**
 * Connected accounts: where posts and ads go.
 *
 * One card per provider, and the card says the three things a person needs:
 * whether it works, which accounts are used and where, and the one thing to
 * do next. A connection that stopped working is the group's dark card,
 * because it is the thing on this screen that is somebody's job right now.
 *
 * Anybody who publishes or sets budgets can see this; only
 * `integration:manage` connects, changes or disconnects.
 */

const VIEW_KEYS = ["integration:manage", "campaign:publish", "campaign.budget:manage"];

const on = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
    : null;

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!VIEW_KEYS.some((k) => viewer.authz.can(k))) redirect("/dashboard/settings");
  const q = await searchParams;
  const error = readFlash(q, "error");

  const [connections, outcomes, crm, whatsapp, sms, portals] = await Promise.all([
    listConnections(viewer.state.org.id),
    uploadSummary(viewer.state.org.id),
    viewer.authz.can("integration:manage") ? crmHealth(viewer.state.org.id) : Promise.resolve(undefined),
    viewer.authz.can("integration:manage") ? whatsappSummary(viewer.state.org.id) : Promise.resolve(undefined),
    viewer.authz.can("integration:manage") ? smsSummary(viewer.state.org.id) : Promise.resolve(undefined),
    viewer.authz.can("integration:manage") ? portalSummary(viewer.state.org.id) : Promise.resolve(undefined),
  ]);
  const mayPrice = viewer.authz.can("campaign.budget:manage");
  const mayManage = viewer.authz.can("integration:manage");
  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  // The one dark card: the first connection that needs a person.
  const needs = connections.find((c) => c.health === "broken" || c.health === "expired")?.provider ?? null;
  // Said only when it is true: a provider named in the address that is still
  // connected was not disconnected.
  const said = typeof q.disconnected === "string" ? q.disconnected.toUpperCase() : "";
  const gone = PROVIDERS.find((p) => p.key === said && !byProvider.has(p.key))?.label;

  return (
    <>
      <PageHead
        title={
          <>
            Connected <span className="em">accounts</span>
          </>
        }
        meta="Where posts and ads go."
        back={{ label: "Settings", href: "/dashboard/settings" }}
      />

      <Flash text={error} name="error" />
      <Flash text={gone ? `${gone} is disconnected. Nothing more goes to it.` : null} name="disconnected" tone="info" />

      <div className="conn-grid">
        {PROVIDERS.map((p) => (
          <ProviderCard
            key={p.key}
            provider={p.key}
            label={p.label}
            detail={p.detail}
            connection={byProvider.get(p.key) ?? null}
            ready={providerReady(p.key)}
            mayManage={mayManage}
            dark={needs === p.key}
          />
        ))}
      </div>

      {(crm !== undefined || whatsapp !== undefined) && (
        <div className="conn-grid crm-conn-row">
          {crm !== undefined && <CrmCard health={crm} />}
          {whatsapp !== undefined && <WhatsAppCard summary={whatsapp} quiet={crmNeedsYou(crm)} />}
          {sms !== undefined && <SmsCard summary={sms} />}
          {portals !== undefined && (
            <PortalsCard summary={portals} dark={portals.waiting > 0 && !crmNeedsYou(crm) && !whatsapp?.needs} />
          )}
        </div>
      )}

      <OutcomesCard platforms={outcomes.platforms} values={outcomes.values} mayPrice={mayPrice} />
    </>
  );
}

const PLATFORM_LABEL = { META: "Meta", GOOGLE: "Google" } as const;

/** Whether the CRM card is its row's dark card, which `CrmCard` decides the same way. */
function crmNeedsYou(crm: Awaited<ReturnType<typeof crmHealth>> | undefined): boolean {
  if (!crm) return false;
  const w = crm.waitingMappings;
  return crm.status === "BROKEN" || crm.dead.length > 0 || w.STAGE + w.PROJECT + w.USER > 0;
}

/**
 * What the ads were told about the leads they brought, over the last 30
 * days, and what each outcome is worth to them.
 */
function OutcomesCard({
  platforms,
  values,
  mayPrice,
}: {
  platforms: UploadSummary[];
  values: { qualified: number; visit: number; booking: number; holdDays: number };
  mayPrice: boolean;
}) {
  const refusals = platforms.filter((p) => p.lastRefusal);
  return (
    <section className="card out" aria-labelledby="out-h">
      <div className="card__head">
        <h2 id="out-h">Outcomes sent to the ads</h2>
        <span className="pill pill--quiet">Last 30 days</span>
      </div>
      <table className="out__table">
        <thead>
          <tr>
            <th scope="col">Platform</th>
            <th scope="col">Sent</th>
            <th scope="col">Waiting</th>
            <th scope="col">Not sent</th>
            <th scope="col">Refused</th>
          </tr>
        </thead>
        <tbody className="tnum">
          {platforms.map((p) => (
            <tr key={p.platform}>
              <td>{PLATFORM_LABEL[p.platform]}</td>
              <td>{p.sent.toLocaleString("en-IN")}</td>
              <td>{p.waiting.toLocaleString("en-IN")}</td>
              <td>{p.notSent.toLocaleString("en-IN")}</td>
              <td>{p.failed.toLocaleString("en-IN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {refusals.map((p) => (
        <p key={p.platform} className="out__why">
          {PLATFORM_LABEL[p.platform]} last refused one: {p.lastRefusal}
        </p>
      ))}
      <div className="out__worth">
        <h3>What each outcome is worth to the ads</h3>
        {mayPrice ? (
          <ValuesForm values={values} />
        ) : (
          <div className="out__read tnum">
            <span className="pill pill--quiet">Qualified lead {rupees(values.qualified)}</span>
            <span className="pill pill--quiet">Site visit done {rupees(values.visit)}</span>
            <span className="pill pill--quiet">Booking {rupees(values.booking)}</span>
            <span className="pill pill--quiet">Bookings wait {values.holdDays} days</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ProviderCard({
  provider,
  label,
  detail,
  connection,
  ready,
  mayManage,
  dark,
}: {
  provider: Provider;
  label: string;
  detail: string;
  connection: ConnectionView | null;
  ready: boolean;
  mayManage: boolean;
  dark: boolean;
}) {
  const slug = providerSlug(provider);
  const health = connection?.health ?? "off";
  const pill = HEALTH_PILL[health];
  const active = connection?.accounts.filter((a) => a.active) ?? [];
  const expires = connection?.tokenExpiresAt ? on(connection.tokenExpiresAt) : null;

  let action: React.ReactNode = null;
  if (!connection) {
    action = mayManage ? (
      ready ? (
        <a href={`/api/connect/${slug}/start`} className="btn btn--ink btn--sm" data-connect={slug}>
          Connect {label}
          <ArrowUpRight size={13} />
        </a>
      ) : (
        <button type="button" className="btn btn--ink btn--sm" disabled aria-describedby={`${slug}-unready`}>
          Connect {label}
        </button>
      )
    ) : null;
  } else if (health === "broken" || health === "expired") {
    action = mayManage && ready ? (
      <a href={`/api/connect/${slug}/start`} className={`btn ${dark ? "btn--light" : "btn--ink"} btn--sm`} data-reconnect={slug}>
        Reconnect {label}
        <ArrowUpRight size={13} />
      </a>
    ) : null;
  } else if (health === "choose") {
    action = mayManage ? (
      <Link href={`/dashboard/settings/connections/${slug}`} className="btn btn--ink btn--sm" data-choose={slug}>
        Choose accounts
        <ArrowUpRight size={13} />
      </Link>
    ) : null;
  }

  return (
    <section className={`conn${dark ? " conn--needs" : ""}`} data-provider={slug} data-health={health}>
      <header className="conn__head">
        <span className="conn__mark">
          <ProviderMark provider={provider} size={20} />
        </span>
        <div className="conn__id">
          <h2>
            {connection ? (
              <Link href={`/dashboard/settings/connections/${slug}`} className="conn__title">
                {label}
              </Link>
            ) : (
              label
            )}
          </h2>
          <p>{detail}</p>
        </div>
        <span className={`pill pill--${pill.tone}`}>
          <span className="pill__dot" />
          {pill.text}
        </span>
      </header>

      {connection && connection.lastError && (health === "broken" || health === "expired") && (
        <p className="conn__error" role="alert">
          {connection.lastError}
        </p>
      )}

      {active.length > 0 ? (
        <ul className="conn__rows">
          {active.map((a) => (
            <li key={a.id} className="conn__row">
              <span className="conn__kind">{accountKindLabel(a.kind)}</span>
              <strong className="conn__name">{a.name}</strong>
              <span className="conn__where">{a.nodeKind === "ORG" ? "Whole organisation" : a.nodeName}</span>
              {(a.kind === "META_AD_ACCOUNT" || a.kind === "GOOGLE_ADS_CUSTOMER") && (
                <span className={`conn__cap${a.dailyCap === null ? " conn__cap--unset" : ""}`}>
                  {a.dailyCap === null ? "No daily limit set" : `Up to ${showRupees(a.dailyCap)} a day`}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="conn__none" id={!connection && !ready ? `${slug}-unready` : undefined}>
          {!connection
            ? ready
              ? "Not connected."
              : `Not switched on for Sales Desk yet.`
            : "Nothing chosen, so nothing goes here yet."}
        </p>
      )}

      <footer className="conn__foot">
        <span className="conn__who">
          {connection
            ? [
                connection.connectedByName ? `Connected by ${connection.connectedByName}` : "Connected",
                on(connection.connectedAt) ? `on ${on(connection.connectedAt)}` : null,
                health === "expiring" && expires ? `· reconnect by ${expires}` : null,
              ]
                .filter(Boolean)
                .join(" ")
            : null}
        </span>
        {action}
        {connection && health !== "choose" && (
          <Link href={`/dashboard/settings/connections/${slug}`} className={`conn__open${dark ? " conn__open--dark" : ""}`}>
            Open
          </Link>
        )}
      </footer>
    </section>
  );
}
