import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { withTenant } from "@/lib/db";
import {
  listPortalAccounts,
  listPortalProjects,
  NOT_OURS,
  portalAddresses,
  portalSummary,
  type PortalAccountView,
  type PortalProjectView,
} from "@/lib/portal-leads";
import { NO_PROJECT, portalLabel } from "@/lib/portal-rules";
import { removeHousingAccountAction, rotatePortalKeyAction, saveHousingAccountAction, savePortalMatchesAction } from "@/app/actions/portals";
import { CopyField } from "../../calling/CopyField";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { Building } from "@/components/icons";
import "../whatsapp/whatsapp.css";
import "./portals.css";

/**
 * Property portals: the address the portals' lead emails are forwarded to,
 * the towers each portal's project wording means, and what arrived.
 *
 * Opens read-only; matching is "Change matches" first. A wording nobody has
 * matched is listed first, with how many enquiries wait on it.
 */

type Tower = { id: string; label: string };

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : null;

export default async function PortalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("integration:manage")) redirect("/dashboard/settings/connections");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const [addresses, projects, summary, nodes, accounts] = await Promise.all([
    portalAddresses(orgId),
    listPortalProjects(orgId),
    portalSummary(orgId),
    withTenant(orgId, (sql) => sql<{ id: string; kind: string; name: string; path: string }[]>`
      SELECT id, kind, name, path::text AS path FROM scope_nodes
      WHERE org_id = ${orgId} AND kind IN ('PROJECT', 'PHASE') ORDER BY path`),
    listPortalAccounts(orgId),
  ]);
  const towers: Tower[] = nodes
    .filter((n) => n.kind === "PHASE")
    .map((t) => {
      const p = nodes.find((n) => n.kind === "PROJECT" && t.path.startsWith(`${n.path}.`));
      return { id: t.id, label: p ? `${p.name} · ${t.name}` : t.name };
    });
  const editing = q.edit === "1" && projects.length > 0;
  const housing = accounts[0] ?? null;
  const housingForm = q.housing === "1";
  const leads = summary.counts.reduce((t, c) => t + c.leads, 0);

  return (
    <>
      <PageHead
        title={
          <>
            <span className="conn__titlemark wa-mark">
              <Building size={18} />
            </span>
            Property <span className="em">portals</span>
          </>
        }
        meta={
          summary.counts.length
            ? `${leads.toLocaleString("en-IN")} ${leads === 1 ? "lead" : "leads"} in the last 30 days`
            : "Leads from 99acres, MagicBricks, Housing.com and NoBroker."
        }
        back={{ label: "Connected accounts", href: "/dashboard/settings/connections" }}
        action={
          editing ? (
            <>
              <Link href="/dashboard/settings/connections/portals" className="btn btn--ghost">
                Cancel
              </Link>
              <button type="submit" form="portal-form" className="btn btn--ink" data-save-portals>
                Save matches
              </button>
            </>
          ) : projects.length ? (
            <Link href="/dashboard/settings/connections/portals?edit=1" className="btn btn--ink" data-change-portals>
              Change matches
            </Link>
          ) : null
        }
      />

      <Flash text={readFlash(q, "done")} name="done" tone="info" />
      <Flash text={readFlash(q, "error")} name="error" />

      <section className="card wa-card" aria-labelledby="pt-addr">
        <div className="card__head">
          <h2 id="pt-addr">Forward portal emails to</h2>
          <span className={`pill pill--${summary.lastAt ? "ok" : "quiet"}`}>
            <span className="pill__dot" />
            {summary.lastAt ? `Last lead ${fmt(summary.lastAt)}` : "Nothing received yet"}
          </span>
        </div>
        <dl className="pt-addr">
          <div className="pt-addr__row">
            <dt>Email address</dt>
            <dd>
              {addresses.mailbox ? (
                <code className="pt-code" data-portal-mailbox>
                  {addresses.mailbox}
                </code>
              ) : (
                <span className="pt-quiet">Email forwarding is not switched on yet.</span>
              )}
            </dd>
          </div>
          <div className="pt-addr__row">
            <dt>Forwarding service</dt>
            <dd>
              {addresses.endpoint ? (
                <code className="pt-code" data-portal-endpoint>
                  {addresses.endpoint}
                </code>
              ) : (
                <span className="pt-quiet">Not available yet.</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="wa-foot">
          <span className="wa-foot__who">{addresses.rotatedAt ? `Changed ${fmt(addresses.rotatedAt)}` : null}</span>
          <ConfirmAction
            label="Make a new address"
            title="Make a new address?"
            body="The address above and every portal link stop working at once. Leads reach you again only after each portal account is given the new address or link."
            confirmLabel="Make a new address"
            action={rotatePortalKeyAction}
            fields={{}}
            tone="ghost"
            testId="portal-rotate"
          />
        </div>
      </section>

      <section className="card wa-card pt-links" aria-labelledby="pt-push">
        <div className="card__head">
          <h2 id="pt-push">Links portals send leads to</h2>
        </div>
        {addresses.pushLinks.length ? (
          <>
            <p className="pt-quiet pt-lead">Send your portal&rsquo;s link to your account manager there and ask them to push your leads to it.</p>
            <div className="pt-linklist">
              {addresses.pushLinks
                .filter((l) => l.portal !== "HOUSING" || !housing)
                .map((l) => (
                  <CopyField key={l.portal} id={`pt-push-${l.portal}`} label={l.portal === "OTHER" ? "Any other portal" : l.label} value={l.url} />
                ))}
            </div>
          </>
        ) : (
          <p className="pt-quiet">Not available yet.</p>
        )}
      </section>

      <HousingCard account={housing} editing={housingForm} />

      <section className="card wa-card" aria-labelledby="pt-proj">
        <div className="card__head">
          <h2 id="pt-proj">Projects the portals name</h2>
          {summary.unmatched > 0 ? (
            <span className="pill pill--warn">
              <span className="pill__dot" />
              {summary.unmatched} not matched
            </span>
          ) : (
            <span className="pill pill--quiet">{projects.length ? "All matched" : "None yet"}</span>
          )}
        </div>
        {projects.length === 0 ? (
          <p className="conn__none">A project appears here the first time a portal names it.</p>
        ) : editing ? (
          <KeptForm action={savePortalMatchesAction} id="portal-form">
            <Matches projects={projects} towers={towers} editing />
          </KeptForm>
        ) : (
          <Matches projects={projects} towers={towers} editing={false} />
        )}
      </section>

      {summary.counts.length > 0 && (
        <section className="card wa-card" aria-labelledby="pt-counts">
          <div className="card__head">
            <h2 id="pt-counts">Received</h2>
            <span className="pill pill--quiet">Last 30 days</span>
          </div>
          <table className="wa-msgs pt-counts">
            <thead>
              <tr>
                <th scope="col">Portal</th>
                <th scope="col">Received</th>
                <th scope="col">Leads</th>
                <th scope="col">Waiting</th>
                <th scope="col">Could not be read</th>
              </tr>
            </thead>
            <tbody>
              {summary.counts.map((c) => (
                <tr key={c.portal} data-portal={c.portal}>
                  <td>
                    <span className="wa-msgs__label">{c.label}</span>
                  </td>
                  <td className="tnum">{c.received.toLocaleString("en-IN")}</td>
                  <td className="tnum">{c.leads.toLocaleString("en-IN")}</td>
                  <td className="tnum">{c.waiting.toLocaleString("en-IN")}</td>
                  <td className="tnum">{c.unread.toLocaleString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function Matches({ projects, towers, editing }: { projects: PortalProjectView[]; towers: Tower[]; editing: boolean }) {
  const name = new Map(towers.map((t) => [t.id, t.label]));
  return (
    // Lays itself out as rows on a phone (portals.css).
    <table className="wa-msgs pt-matches" data-keep>
      <thead>
        <tr>
          <th scope="col">The portal wrote</th>
          <th scope="col">Tower</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr key={p.id} data-portal-project={p.key}>
            <td>
              <span className="wa-msgs__label">{p.key === NO_PROJECT ? "No project named" : (p.text ?? p.key)}</span>
              <span className="pt-from">
                {portalLabel(p.portal)}
                {p.waiting > 0 && ` · ${p.waiting} ${p.waiting === 1 ? "lead waits" : "leads wait"}`}
              </span>
            </td>
            <td className="pt-tower">
              {editing ? (
                <select
                  name={`m_${p.id}`}
                  className="select-field"
                  defaultValue={p.notOurs ? NOT_OURS : (p.phaseId ?? "")}
                  aria-label={`Tower for ${p.text ?? "enquiries with no project named"}`}
                >
                  <option value="">Choose a tower</option>
                  {towers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                  <option value={NOT_OURS}>Not one of our projects</option>
                </select>
              ) : p.notOurs ? (
                <span className="pill pill--quiet">Not ours</span>
              ) : p.phaseId ? (
                <span className="pt-matched">
                  {name.get(p.phaseId) ?? "A tower"}
                  {p.byName && <small>Same name</small>}
                </span>
              ) : (
                <span className="pill pill--warn">
                  <span className="pill__dot" />
                  Not matched
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })
    : null;

/** Housing.com's lead API: read-only once connected, a form only when asked for. */
function HousingCard({ account, editing }: { account: PortalAccountView | null; editing: boolean }) {
  if (editing) {
    return (
      <KeptForm action={saveHousingAccountAction} className="card wa-card" id="pt-housing-form">
        <div className="card__head">
          <h2>Housing.com account</h2>
          <div className="pt-actions">
            <Link href="/dashboard/settings/connections/portals" className="btn btn--ghost btn--sm">
              Cancel
            </Link>
            <button type="submit" className="btn btn--ink btn--sm" data-save-housing>
              Save and check
            </button>
          </div>
        </div>
        <p className="pt-quiet pt-lead">Ask your Housing.com account manager for your builder lead API&rsquo;s account ID and secret key.</p>
        <div className="pt-fields">
          <label className="formfield" htmlFor="pt-hs-id">
            <span className="formfield__label">Account ID</span>
            <input
              id="pt-hs-id"
              name="accountId"
              className="formfield__input"
              required
              autoComplete="off"
              spellCheck={false}
              defaultValue={account?.accountId ?? ""}
              readOnly={!!account}
              placeholder="e.g. 4544"
            />
          </label>
          <label className="formfield" htmlFor="pt-hs-key">
            <span className="formfield__label">Secret key</span>
            <input
              id="pt-hs-key"
              name="secretKey"
              type="password"
              className="formfield__input"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the key"
            />
          </label>
        </div>
      </KeptForm>
    );
  }
  return (
    <section className="card wa-card" aria-labelledby="pt-housing">
      <div className="card__head">
        <h2 id="pt-housing">Housing.com account</h2>
        {account ? (
          <span className={`pill pill--${account.status === "BROKEN" ? "risk" : account.lastOkAt ? "ok" : "quiet"}`}>
            <span className="pill__dot" />
            {account.status === "BROKEN" ? "Stopped" : account.lastOkAt ? "Working" : "Not read yet"}
          </span>
        ) : (
          <Link href="/dashboard/settings/connections/portals?housing=1" className="btn btn--ink btn--sm" data-connect-housing>
            Connect Housing.com
          </Link>
        )}
      </div>
      {account ? (
        <>
          <dl className="pt-addr">
            <div className="pt-addr__row">
              <dt>Account ID</dt>
              <dd>{account.accountId}</dd>
            </div>
            <div className="pt-addr__row">
              <dt>Last read</dt>
              <dd>{day(account.lastOkAt) ?? "Not yet"}</dd>
            </div>
            <div className="pt-addr__row">
              <dt>Leads read</dt>
              <dd className="tnum">{account.leadsRead.toLocaleString("en-IN")}</dd>
            </div>
            {account.lastError && (
              <div className="pt-addr__row">
                <dt>Last try</dt>
                <dd className={account.status === "BROKEN" ? "pt-risk" : "pt-quiet"}>{account.lastError}</dd>
              </div>
            )}
          </dl>
          <div className="wa-foot">
            <span className="wa-foot__who" />
            <div className="pt-actions">
              <Link href="/dashboard/settings/connections/portals?housing=1" className="btn btn--ghost btn--sm" data-change-housing>
                {account.status === "BROKEN" ? "Save a new key" : "Change key"}
              </Link>
              <ConfirmAction
                label="Remove"
                title="Remove Housing.com?"
                body="Housing.com leads stop arriving here, and the saved key is deleted. Leads already on the board stay."
                confirmLabel="Remove Housing.com"
                action={removeHousingAccountAction}
                fields={{ id: account.id }}
                tone="ghost"
                testId="housing-remove"
              />
            </div>
          </div>
        </>
      ) : (
        <p className="pt-quiet">Connect it to have Housing.com leads read every ten minutes.</p>
      )}
    </section>
  );
}
