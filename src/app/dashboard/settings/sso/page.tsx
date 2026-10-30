import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight } from "@/components/icons";
import { listOrgRoles } from "@/lib/rbac";
import { listScopeNodes } from "@/lib/scope-nodes";
import { nodesWithin, reachFor, treeOrder } from "@/lib/scope-rules";
import { ssoSettings } from "@/lib/sso";
import { scimOverview } from "@/lib/scim";
import { CopyField } from "../calling/CopyField";
import { AddDomain, DomainRow, EnforceButton, GroupMapping, NewToken, ProviderForm, RevokeToken } from "./SsoForms";
import "../calling/calling.css";
import "./sso.css";

/**
 * Single sign-on and provisioning, for the company's IT team: our details
 * to paste into their identity provider, theirs to paste here, the domains
 * it signs in, whether it is required, and the SCIM token and group roles
 * that let it add and remove people.
 */
export default async function SsoPage({ searchParams }: { searchParams: Promise<{ tested?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.canAt("org:manage", viewer.state.rootPath)) redirect("/dashboard/settings");
  const orgId = viewer.state.org.id;
  const [s, scim, roles, allNodes, q] = await Promise.all([ssoSettings(orgId), scimOverview(orgId), listOrgRoles(orgId), listScopeNodes(orgId), searchParams]);

  const c = s.config;
  const proved = s.domains.filter((d) => d.verified).length;
  const state = !c ? "off" : c.enforce ? "required" : c.testedAt ? "optional" : "untested";
  const meta = {
    off: "Off. People sign in with Google or Microsoft.",
    untested: "Set up, and nobody has signed in through it yet",
    optional: "On, and optional",
    required: "Required for everyone on your proved domains",
  }[state];
  const enforceWhy = !c ? "Set up your identity provider first." : !c.testedAt ? "Sign in through it once first." : !proved ? "Prove a domain first." : null;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  const nodes = treeOrder(nodesWithin(allNodes, viewer.authz.scopesFor("member:invite")));
  const reach = reachFor(roles, nodes, viewer.authz.heldAt).map((r) => ({ key: r.key, label: r.label, at: r.at }));
  const label = new Map(roles.map((r) => [r.key, r.label]));
  const places = nodes.map((n) => ({ id: n.id, label: `${"  ".repeat(n.path.split(".").length - 1)}${n.name}` }));

  return (
    <>
      <PageHead
        back={{ label: "Settings", href: "/dashboard/settings" }}
        title={
          <>
            Single <span className="em">sign-on</span>
          </>
        }
        meta={meta}
        action={
          state === "untested" ? (
            <a href={`/api/sso/${orgId}/login?test=1`} className="btn btn--ink">
              Test sign-in
              <ArrowUpRight size={14} />
            </a>
          ) : state === "optional" ? (
            <EnforceButton on={false} disabledWhy={enforceWhy} primary />
          ) : null
        }
      />

      {q.tested === "1" && (
        <p className="note note--info" role="status" style={{ marginBottom: 14 }}>
          You signed in through your identity provider. It works.
        </p>
      )}

      <div className="sso-grid">
        {/* Two columns that fill independently: what they paste here on the
            left, what they paste into their provider on the right. */}
        <div className="sso-col">
          <section className="card sso-card" aria-labelledby="sso-provider">
            <h2 id="sso-provider">Your identity provider</h2>
            {c && (
              <dl className="sso-facts">
                <div>
                  <dt>Entity ID</dt>
                  <dd className="sso-mono">{c.entityId}</dd>
                </div>
                <div>
                  <dt>Sign-in URL</dt>
                  <dd className="sso-mono">{c.ssoUrl}</dd>
                </div>
                <div>
                  <dt>{c.certificates.length === 1 ? "Certificate" : "Certificates"}</dt>
                  <dd>{c.certificates.map((x) => (x.validTo ? `Valid until ${day(x.validTo)}` : "Unreadable")).join(" · ")}</dd>
                </div>
                <div>
                  <dt>Last sign-in through it</dt>
                  <dd>{c.testedAt ? `${day(c.testedAt)}${c.testedBy ? `, ${c.testedBy}` : ""}` : "None yet"}</dd>
                </div>
              </dl>
            )}
            <ProviderForm current={c ? { entityId: c.entityId, ssoUrl: c.ssoUrl } : null} open={!c} />
          </section>
          {c && (
            <section className="card sso-card" aria-labelledby="sso-require">
              <h2 id="sso-require">Required or optional</h2>
              <p className="sso-line">
                {c.enforce
                  ? "Everyone on your proved domains signs in through your provider. Admins can still use Google or Microsoft."
                  : "People may use your provider, Google or Microsoft."}
              </p>
              {state !== "optional" && <EnforceButton on={c.enforce} disabledWhy={enforceWhy} />}
              {state !== "required" && enforceWhy && <p className="sso-muted sso-small">{enforceWhy}</p>}
            </section>
          )}
        </div>
        <div className="sso-col">
          <section className="card sso-card" aria-labelledby="sso-ours">
            <h2 id="sso-ours">Sales Desk&rsquo;s details for your provider</h2>
            <div className="sso-copies">
              <CopyField id="sp-entity" label="Entity ID (audience)" value={s.sp.entityId} />
              <CopyField id="sp-acs" label="ACS URL (reply URL)" value={s.sp.acsUrl} />
              <CopyField id="sp-meta" label="Metadata URL" value={s.sp.metadataUrl} />
            </div>
            <p className="sso-muted sso-small">Send the email address as the NameID.</p>
          </section>
          <section className="card sso-card" aria-labelledby="sso-domains">
            <h2 id="sso-domains">Domains it signs in</h2>
            {s.domains.length === 0 ? (
              <p className="sso-muted">No domain yet. {s.primaryDomain ? `${s.primaryDomain} is added when you save your provider.` : "Add your company's mail domain."}</p>
            ) : (
              <ul className="sso-domains">
                {s.domains.map((d) => (
                  <DomainRow key={d.domain} domain={d.domain} verified={d.verified} record={d.record} />
                ))}
              </ul>
            )}
            <AddDomain />
          </section>
        </div>

        <section className="card sso-card sso-card--wide" aria-labelledby="sso-scim">
          <h2 id="sso-scim">Adding and removing people automatically</h2>
          <p className="sso-line">
            {scim.people
              ? `${scim.people} ${scim.people === 1 ? "person" : "people"} from your provider, ${scim.active} active.`
              : "Your provider adds people here, and removes them when they leave, through SCIM."}
          </p>
          <div className="sso-copies">
            <CopyField id="scim-base" label="SCIM base URL" value={scim.base} />
          </div>
          {scim.tokens.length > 0 && (
            <table className="ws-table sso-table">
              <thead>
                <tr>
                  <th scope="col">Token</th>
                  <th scope="col">Made</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="sr-only">Revoke</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {scim.tokens.map((t) => (
                  <tr key={t.id} className={t.revoked ? "sso-revoked" : undefined}>
                    <td>
                      {t.label}
                      {t.revoked && <span className="pill pill--quiet" style={{ marginLeft: 8 }}>Revoked</span>}
                    </td>
                    <td className="tnum">{day(t.createdAt)}</td>
                    <td className="tnum">{t.lastUsedAt ? day(t.lastUsedAt) : "Never"}</td>
                    <td>{!t.revoked && <RevokeToken id={t.id} label={t.label} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <NewToken />
        </section>

        {scim.groups.length > 0 && (
          <section className="card sso-card sso-card--wide" aria-labelledby="sso-groups">
            <h2 id="sso-groups">What each group gives</h2>
            <table className="ws-table sso-table">
              <thead>
                <tr>
                  <th scope="col">Group in your provider</th>
                  <th scope="col" className="ws-num">People</th>
                  <th scope="col">Gives</th>
                </tr>
              </thead>
              <tbody>
                {scim.groups.map((g) => (
                  <tr key={g.id}>
                    <td>{g.name}</td>
                    <td className="ws-num tnum">{g.members}</td>
                    <td>
                      <GroupMapping
                        groupId={g.id}
                        current={{ role: g.role, roleLabel: g.role ? label.get(g.role) ?? g.role : null, nodeId: g.nodeId, nodeName: g.nodeName }}
                        roles={reach}
                        places={places}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}
