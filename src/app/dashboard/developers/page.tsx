import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listEntities } from "@/lib/entity";
import { listProjects } from "@/lib/project";
import { inReach } from "@/lib/grant-rules";
import { mandatesForFirm } from "@/lib/mandates";
import { mandateContexts } from "@/lib/grant-access";
import { firmCommission } from "@/lib/firm-workspace";
import { rupees } from "@/lib/lead-rules";
import { HALF_STATE, MANDATE_STATE, commissionTotals, halfState, lastDay, longDay, rejectWords, showRate } from "@/lib/mandate-rules";
import { switchOrgAction } from "@/app/actions/org";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight } from "@/components/icons";
import { AnswerOffer } from "@/app/workspace/AnswerOffer";
import { AskLonger } from "@/app/workspace/AskLonger";
import { PartnerDevelopers } from "./PartnerDevelopers";
import { SendInvoice } from "@/app/workspace/SendInvoice";
import "@/app/workspace/workspace.css";

/**
 * A mandate firm's Developers: every developer it sells for, in one list.
 * The ones it added itself, whose projects it works in this console, and
 * the ones on Sales Desk who gave it a mandate, whose projects it opens in
 * their console. Above them the offers to answer; below, the mandates and
 * what each booking earned it.
 */
export default async function DevelopersPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  // A channel partner's developers are the ones that empanelled it; a mandate firm's, the ones it sells for.
  if (viewer.orgType === "CHANNEL_PARTNER" && !viewer.via) return <PartnerDevelopers viewer={viewer} />;
  if (viewer.orgType !== "MANDATE_FIRM" || viewer.via) redirect("/dashboard");

  const orgId = viewer.state.org.id;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const seesMoney = viewer.authz.can("payout:read");
  const mayInvoice = seesMoney && viewer.authz.can("partner:register");
  const mayAnswer = viewer.authz.can("org:manage");
  const canAdd = viewer.authz.can("project:create");
  const seesProjects = canAdd || viewer.authz.can("project:read");
  const [mandates, contexts, commission, allEntities, allProjects] = await Promise.all([
    mandatesForFirm(orgId),
    mandateContexts(viewer.userId),
    seesMoney ? firmCommission(orgId) : Promise.resolve([]),
    seesProjects ? listEntities(orgId) : Promise.resolve([]),
    seesProjects ? listProjects(orgId) : Promise.resolve([]),
  ]);

  // The developers it added, as Projects shows them: somebody placed on one
  // project sees that project's developer and nothing else.
  const reach = [...new Set([...viewer.authz.scopesFor("project:read"), ...viewer.authz.scopesFor("project:create")])];
  const projects = allProjects.filter((p) => inReach(p.path, reach));
  const own = (canAdd ? allEntities : allEntities.filter((e) => projects.some((p) => p.entityId === e.id))).map((e) => ({
    id: e.id,
    name: e.name,
    projects: projects.filter((p) => p.entityId === e.id).map((p) => p.name),
  }));

  const offers = mandates.filter((m) => m.state === "offered");
  const live = mandates.filter((m) => m.state === "live" || m.state === "not_started");
  const past = mandates.filter((m) => !["offered", "live", "not_started"].includes(m.state));
  const open = contexts.filter((c) => c.firmOrgId === orgId);
  const totals = commissionTotals(commission, today);
  const count = own.length + open.length;

  return (
    <>
      <PageHead
        title={
          <>
            Developers you <span className="em">sell</span> for
          </>
        }
        meta={
          count === 0 && offers.length === 0
            ? "No developer yet"
            : [
                count > 0 ? `${count} ${count === 1 ? "developer" : "developers"}` : null,
                offers.length > 0 ? `${offers.length} ${offers.length === 1 ? "offer" : "offers"} waiting for your answer` : null,
              ]
                .filter(Boolean)
                .join(" · ")
        }
        action={
          canAdd ? (
            <Link href="/dashboard/settings/entities#add" className="btn btn--ink">
              Add a developer
              <ArrowUpRight size={14} />
            </Link>
          ) : null
        }
      />

      <div className="fw-stack">
        {offers.length > 0 && (
          <section className="fw-offers" aria-label="Offers waiting for your answer">
            <h2>{offers.length === 1 ? "An offer is" : `${offers.length} offers are`} waiting for your answer</h2>
            <ul>
              {offers.map((m) => (
                <li key={m.id} className="fw-offer">
                  <span className="fw-offer__what">
                    <span className="fw-offer__dev">{m.developer}</span>
                    <span className="fw-offer__line">
                      {m.projects.join(", ")} · {showRate(m.rate)} on every booking · until {longDay(lastDay(m.validTo))}
                      {m.tailDays > 0 ? ` · then ${m.tailDays} days on buyers who came during it` : ""}
                    </span>
                    <span className="fw-offer__line">Offered {longDay(m.offeredOn)}</span>
                  </span>
                  {mayAnswer ? (
                    <AnswerOffer mandateId={m.id} developer={m.developer} />
                  ) : (
                    <span className="fw-offer__line">Your firm&rsquo;s admin answers this.</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card fw-card" aria-label="Developers">
          <div className="fw-card__head">
            <h2>Developers</h2>
            {count > 0 && <span className="pill pill--quiet">{count}</span>}
          </div>
          {count === 0 ? (
            <p className="fw-empty">
              {canAdd ? "Add each developer whose projects you sell. " : ""}A developer on Sales Desk can also offer you a mandate by your PAN,{" "}
              <span className="pt-mono">{viewer.state.org.pan}</span>.
            </p>
          ) : (
            <ul className="fw-open">
              {open.map((c) => {
                const ms = live.filter((m) => m.developerOrgId === c.devOrgId && m.state === "live");
                return (
                  <li key={c.devOrgId} className="fw-open__row" data-developer="mandate">
                    <span className="fw-open__what">
                      <span className="fw-open__dev">
                        {c.devName} <span className="pill pill--blue">On Sales Desk</span>
                      </span>
                      <span className="fw-open__line">
                        {/* Each mandate has its own last day, so one date for several read as all of them ending then. */}
                        {ms.length === 1
                          ? `${ms[0].projects.join(", ")} · your mandate runs until ${longDay(lastDay(ms[0].validTo))}`
                          : ms.map((m) => `${m.projects.join(", ")} until ${longDay(lastDay(m.validTo))}`).join(" · ")}
                      </span>
                    </span>
                    <form action={switchOrgAction}>
                      <input type="hidden" name="orgId" value={c.devOrgId} />
                      <button type="submit" className="btn btn--ink">
                        Open projects
                        <ArrowUpRight size={14} />
                      </button>
                    </form>
                  </li>
                );
              })}
              {own.map((e) => (
                <li key={e.id} className="fw-open__row" data-developer="own">
                  <span className="fw-open__what">
                    <span className="fw-open__dev">{e.name}</span>
                    <span className="fw-open__line">{e.projects.length > 0 ? e.projects.join(", ") : "No project yet"}</span>
                  </span>
                  {e.projects.length > 0 ? (
                    <Link href="/dashboard/projects" className="btn btn--ghost">
                      Projects
                      <ArrowUpRight size={14} />
                    </Link>
                  ) : canAdd ? (
                    <Link href="/dashboard/projects" className="btn btn--ghost">
                      Add a project
                      <ArrowUpRight size={14} />
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {seesMoney && commission.length === 0 && live.length > 0 && (
          <section className="card fw-card" aria-label="Commission">
            <h2>Commission</h2>
            <p className="fw-empty">No booking under your mandates yet. Each one appears here with what it earns you once the developer records it.</p>
          </section>
        )}

        {seesMoney && commission.length > 0 && (
          <section className="card fw-card fw-money" aria-label="Commission">
            <span className="fw-money__item">
              <span className="fw-money__label">Owed to you</span>
              <span className="fw-money__value tnum">{rupees(totals.owed)}</span>
            </span>
            <span className="fw-money__item">
              <span className="fw-money__label">Invoices to send</span>
              <span className="fw-money__value tnum">{totals.toInvoice}</span>
            </span>
            <span className="fw-money__item">
              <span className="fw-money__label">Paid in the last year</span>
              <span className="fw-money__value tnum">{rupees(totals.paidYear)}</span>
            </span>
          </section>
        )}

        {live.length + past.length > 0 && (
          <section className="card fw-card" aria-label="Mandates">
            <h2>Mandates</h2>
            <table className="fw-table">
              <thead>
                <tr>
                  <th scope="col">Developer</th>
                  <th scope="col">Projects</th>
                  <th scope="col">Commission</th>
                  <th scope="col">Runs until</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="fw-table__end">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...live, ...past].map((m) => {
                  const asked = m.extensionAskedAt ? lastDay(m.extensionAskedAt) : null;
                  // An ended or withdrawn mandate stopped on the day it was ended, not on its last day.
                  const stopped = (m.status === "ENDED" || m.status === "WITHDRAWN") && m.endedAt ? lastDay(m.endedAt) : null;
                  return (
                    <tr key={m.id}>
                      <td>{m.developer}</td>
                      <td>{m.projects.join(", ")}</td>
                      <td>
                        <span className="fw-book">
                          <span className="tnum">{showRate(m.rate)}</span>
                          {m.tailDays > 0 && <span className="fw-book__line">then {m.tailDays} days on buyers who came during it</span>}
                        </span>
                      </td>
                      <td className="tnum">
                        {stopped ? (
                          <span className="fw-book">
                            <span>Ended {longDay(stopped)}</span>
                            <span className="fw-book__line">was until {longDay(lastDay(m.validTo))}</span>
                          </span>
                        ) : (
                          longDay(lastDay(m.validTo))
                        )}
                      </td>
                      <td>
                        <span className={`pill pill--${MANDATE_STATE[m.state].tone}`}>
                          <span className="pill__dot" />
                          {MANDATE_STATE[m.state].label}
                        </span>
                      </td>
                      <td className="fw-table__end">
                        {m.state === "live" &&
                          (asked ? (
                            <span className="fw-book__line">Asked to run longer on {longDay(asked)}</span>
                          ) : mayAnswer ? (
                            <AskLonger mandateId={m.id} />
                          ) : null)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {seesMoney && commission.length > 0 && (
          <section className="card fw-card" aria-label="Commission by booking">
            <div className="fw-card__head">
              <h2>Commission by booking</h2>
              <span className="fw-card__meta">
                {rupees(totals.owed)} owed · {rupees(totals.paidYear)} paid in the last year
              </span>
            </div>
            <table className="fw-table fw-table--dense">
              <thead>
                <tr>
                  <th scope="col">Booking</th>
                  <th scope="col">Agreement</th>
                  <th scope="col">First half</th>
                  <th scope="col">Second half</th>
                </tr>
              </thead>
              <tbody>
                {commission.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="fw-book">
                        <span className="fw-book__what">
                          {c.developer} · {c.project}
                          {c.unit ? ` · ${c.unit}` : ""}
                        </span>
                        <span className="fw-book__line">
                          {c.buyer ? `${c.buyer} · ` : ""}Booked {longDay(c.bookedOn)} · {showRate(c.rate)}
                        </span>
                      </span>
                    </td>
                    <td className="tnum">{rupees(c.agreement)}</td>
                    {(["M1", "M2"] as const).map((k) => {
                      const h = c.halves.find((x) => x.key === k);
                      if (!h) return <td key={k}>Nothing yet</td>;
                      const s = halfState(h, c.cancelled);
                      return (
                        <td key={k}>
                          <span className="fw-half">
                            <span className="tnum">{rupees(h.net)}</span>
                            <span className={`pill pill--${HALF_STATE[s].tone}`}>
                              <span className="pill__dot" />
                              {s === "paid" && h.paidOn ? `Paid ${longDay(h.paidOn)}` : HALF_STATE[s].label}
                            </span>
                            {s === "send_invoice" && h.rejected && (
                              <span className="fw-book__line fw-book__line--risk">
                                Sent back{h.invoiceNo ? ` (invoice ${h.invoiceNo})` : ""}: {rejectWords(h.rejectReason)}
                              </span>
                            )}
                            {s === "send_invoice" && <span className="fw-book__line">{rupees(h.gross)} to invoice</span>}
                            {(s === "with_developer" || s === "approved" || s === "paid") && h.invoiceNo && (
                              <span className="fw-book__line">
                                Invoice {h.invoiceNo}
                                {h.invoiceDate ? `, ${longDay(h.invoiceDate)}` : ""}
                              </span>
                            )}
                            {s === "send_invoice" && mayInvoice && (
                              <SendInvoice
                                payoutId={c.id}
                                half={k}
                                gross={h.gross.toLocaleString("en-IN")}
                                what={`${c.developer} · ${c.project}${c.unit ? ` · ${c.unit}` : ""} · ${k === "M1" ? "first" : "second"} half, ${rupees(h.gross)}`}
                                today={today}
                              />
                            )}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {totals.toInvoice > 0 && <p className="fw-foot">Invoice each half for the gross amount shown. The developer pays the net, after TDS.</p>}
          </section>
        )}
      </div>
    </>
  );
}
