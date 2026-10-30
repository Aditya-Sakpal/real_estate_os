import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { overview, type UnitStanding } from "@/lib/billing";
import { AGENT_JOB_LABEL, STATE_NAMES, UNIT_WORDS, amountOf, type AllowanceUnit } from "@/lib/billing-rules";
import { purchasingOpen } from "@/lib/razorpay";
import { planRequired } from "@/lib/plan-purchase-rules";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight, Wallet } from "@/components/icons";
import { saveBillingDetailsAction } from "@/app/actions/billing";
import { BillingTabs } from "./BillingTabs";
import { Meter } from "./Meter";
import { capsOf } from "@/lib/project-caps";
import { CAP_UNITS, CAP_WORDS, capsLine } from "@/lib/project-cap-rules";
import { saveProjectCapsAction } from "@/app/actions/caps";
import { KeptForm } from "@/components/KeptForm";
import { renewalsFor } from "@/lib/plan-renewal";
import { renewalWords } from "@/lib/plan-renewal-rules";
import { rupees as billRupees } from "@/lib/billing-rules";
import { payRenewalAction } from "@/app/actions/billing";
import { PayCharge } from "./auto/PayCharge";
import "./billing.css";

/**
 * Plan and usage. Per project: its plan, and what this month's allowance has
 * left. For the organisation: its top-ups with their dates, its Ask Jimmy
 * questions, and who the invoices are made out to.
 *
 * Billing details open read-only; Edit is a decision. The one action at the
 * top is Top up, and only for whoever may buy, where buying is open.
 */

const UNIT_LABEL: Record<AllowanceUnit, string> = {
  MINUTE: "AI call minutes",
  IMAGE: "Image posts",
  CAROUSEL: "Carousels",
  VIDEO: "Videos",
};

const monthName = (period: string) =>
  new Date(`${period}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const nextMonthName = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });
};
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("billing:read")) redirect("/dashboard/settings");
  const orgId = viewer.state.org.id;
  const canManage = viewer.authz.can("billing:manage");

  const [o, params, caps, renewals] = await Promise.all([overview(orgId), searchParams, capsOf(orgId), renewalsFor(orgId)]);
  // A month's plan is shown once it is money: in shadow mode nothing is charged, so nothing is said.
  const owed = o.mode === "LIVE" ? renewals : [];
  const todayIst = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  // A project's own limit on the shared allowance, opened one project at a time.
  const limitsFor = canManage && o.pool && typeof params.limits === "string" ? params.limits : null;
  const canBuy = canManage && purchasingOpen(o.mode);
  const editing = canManage && params.edit === "details" && !!o.account;

  const meters = (units: UnitStanding[]) => (
    <div className="bill-meters">
      {units.map((u) => (
        <Meter key={u.unit} label={UNIT_LABEL[u.unit]} used={u.used} allowance={u.allowance} />
      ))}
    </div>
  );

  // Read-only, the details sit under Ask Jimmy beside the top-ups; while
  // they are edited the form takes the whole width.
  const details = o.account ? (
            <section className="card" id="details" data-billing-details>
              <div className="card__head">
                <h2>Billing details</h2>
                {canManage && !editing && (
                  <Link href="/dashboard/settings/billing?edit=details#details" className="btn btn--light btn--sm" data-edit-details>
                    Edit
                  </Link>
                )}
              </div>
              {editing ? (
                <form action={saveBillingDetailsAction} className="bill-form">
                  <div className="field">
                    <label htmlFor="bill-name">Invoice to</label>
                    <input id="bill-name" name="name" type="text" defaultValue={o.account.billName} maxLength={200} placeholder={viewer.state.org.legalName} />
                  </div>
                  <div className="bill-form__row">
                    <div className="field">
                      <label htmlFor="bill-gstin">GSTIN</label>
                      <input id="bill-gstin" name="gstin" type="text" defaultValue={o.account.billGstin ?? ""} maxLength={15} placeholder="27ABCDE1234F1Z5" autoCapitalize="characters" spellCheck={false} />
                    </div>
                    <div className="field">
                      <label htmlFor="bill-state">State</label>
                      <select id="bill-state" name="state" className="select-field" defaultValue={o.account.billState ?? ""}>
                        <option value="">From the GSTIN</option>
                        {Object.entries(STATE_NAMES).map(([code, name]) => (
                          <option key={code} value={code}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="bill-address">Address</label>
                    <textarea id="bill-address" name="address" rows={3} maxLength={500} defaultValue={o.account.billAddress ?? ""} placeholder="Office no., building, road, city, PIN" />
                  </div>
                  <div className="field">
                    <label htmlFor="bill-email">Invoices go to</label>
                    <input id="bill-email" name="email" type="email" defaultValue={o.account.billEmail ?? ""} maxLength={254} placeholder="accounts@yourcompany.com" />
                  </div>
                  <div className="bill-form__actions">
                    <button type="submit" className="btn btn--ink">
                      Save details
                    </button>
                    <Link href="/dashboard/settings/billing#details" className="btn btn--ghost">
                      Cancel
                    </Link>
                  </div>
                </form>
              ) : (
                <div className="facts bill-facts">
                  <div className="fact">
                    <div className="fact__k">Invoice to</div>
                    <div className="fact__v">{o.account.billName}</div>
                  </div>
                  <div className="fact">
                    <div className="fact__k">GSTIN</div>
                    <div className="fact__v">{o.account.billGstin ?? "Not given"}</div>
                  </div>
                  <div className="fact">
                    <div className="fact__k">State</div>
                    <div className="fact__v">{o.account.billState ? STATE_NAMES[o.account.billState] ?? o.account.billState : "Not given"}</div>
                  </div>
                  <div className="fact">
                    <div className="fact__k">Invoices go to</div>
                    <div className="fact__v">{o.account.billEmail ?? "Not given"}</div>
                  </div>
                  <div className="fact bill-fact--wide">
                    <div className="fact__k">Address</div>
                    <div className="fact__v">{o.account.billAddress ?? "Not given"}</div>
                  </div>
                </div>
              )}
            </section>
  ) : null;

  return (
    <>
      <PageHead
        title={
          <>
            Plan and <span className="em">usage</span>
          </>
        }
        meta={
          o.mode ? (
            <>
              {monthName(o.period)}, renewed on {nextMonthName(o.period)}
              {o.mode === "SHADOW" && <span className="pill pill--quiet bill-mode">Not billed yet</span>}
            </>
          ) : (
            "No plan yet"
          )
        }
        action={
          canBuy ? (
            <Link href="/dashboard/settings/billing/top-up" className="btn btn--ink">
              Top up
              <ArrowUpRight size={14} />
            </Link>
          ) : null
        }
      />
      <BillingTabs current="usage" canManage={canManage} />

      <Flash text={readFlash(params, "saved")} name="saved" tone="info" style={{ marginBottom: 16 }} />
      <Flash text={readFlash(params, "error")} name="error" style={{ marginBottom: 16 }} />

      {!o.mode ? (
        <section className="card empty" data-billing-none>
          <span className="empty__mark">
            <Wallet size={18} />
          </span>
          <h2>No plan yet</h2>
          {planRequired(process.env) ? (
            <>
              <p className="sub">{viewer.orgType === "CHANNEL_PARTNER" ? "One plan covers all your projects." : "Each project comes with its own plan."}</p>
              <Link href="/dashboard/projects?new=1#new-project" className="btn btn--ink btn--sm" style={{ marginTop: 12 }}>
                {viewer.orgType === "CHANNEL_PARTNER" ? "Choose a plan" : "Add a project and its plan"}
                <ArrowUpRight size={13} />
              </Link>
            </>
          ) : (
            <p className="sub">Plans are set up with you, one for each project. Ask us to start one.</p>
          )}
        </section>
      ) : (
        <>
          {owed.map((r) => {
            const w = renewalWords(r, todayIst, (d) => shortDate(`${d}T00:00:00+05:30`));
            return (
              <section key={r.id} className="card bill-renewal" data-billing-renewal={r.status}>
                <div className="card__head">
                  <h2>Your plan for {monthName(r.period)}</h2>
                  <span className={`pill pill--${w.tone}`}>{w.label}</span>
                </div>
                <p className="bill-renewal__amount tnum">{billRupees(r.totalPaise, true)}</p>
                <p className="sub">{w.line}</p>
                {r.status === "AWAITING_APPROVAL" && canBuy && (
                  <PayCharge chargeId={r.id} label={`Pay ${billRupees(r.totalPaise, true)}`} start={payRenewalAction} className="btn btn--ink btn--sm" />
                )}
              </section>
            );
          })}

          {o.pool && (
            <section className="card bill-pool" data-billing-pool>
              <div className="card__head">
                <h2>Shared across your projects</h2>
                <span className="pill pill--blue">{o.projects.filter((p) => p.sub).length} projects</span>
              </div>
              {meters(o.pool)}
            </section>
          )}

          <section className="card" data-billing-projects>
            <div className="card__head">
              <h2>Projects</h2>
              <span className="pill pill--quiet">{monthName(o.period)}</span>
            </div>
            <ul className="bill-projects">
              {[...o.projects].sort((a, b) => Number(!a.sub) - Number(!b.sub)).map((p) => (
                <li key={p.id} id={`p-${p.id}`} className="bill-proj" data-billing-project={p.id}>
                  <div className="bill-proj__id">
                    <div className="bill-proj__name">
                      <span>{p.name}</span>
                      {p.sub ? (
                        p.sub.status === "PILOT" ? (
                          <span className="pill pill--warn">Pilot{p.sub.endsOn ? `, until ${shortDate(`${p.sub.endsOn}T00:00:00+05:30`)}` : ""}</span>
                        ) : (
                          <span className="pill pill--blue">
                            {p.sub.label}
                            {p.sub.cycle === "ANNUAL" ? ", yearly" : ""}
                          </span>
                        )
                      ) : (
                        <span className="pill pill--quiet">No plan</span>
                      )}
                    </div>
                    <p className="bill-proj__sub">
                      {p.sub
                        ? `${p.sub.channels} calls at once · ${p.sub.agents.map((a) => AGENT_JOB_LABEL[a]).join(", ")}`
                        : "Nothing that costs money runs here until it has a plan."}
                    </p>
                  </div>
                  {p.sub && !o.pool && meters(p.units)}
                  {p.sub && o.pool && (
                    <div className="bill-proj__pooled" data-project-limits={p.id}>
                      <p style={{ margin: 0 }}>
                        Uses the shared allowance above
                        {capsLine(caps.get(p.id) ?? {}) ? `, at most ${capsLine(caps.get(p.id) ?? {})} a month` : ""}.
                      </p>
                      {caps.get(p.id) && meters(p.units.filter((u) => caps.get(p.id)?.[u.unit as keyof typeof CAP_WORDS] !== undefined).map((u) => ({ ...u, allowance: caps.get(p.id)![u.unit as keyof typeof CAP_WORDS]! })))}
                      {canManage && limitsFor !== p.id && (
                        <Link href={`/dashboard/settings/billing?limits=${p.id}#p-${p.id}`} className="btn btn--light btn--sm" data-set-limits={p.id}>
                          {caps.get(p.id) ? "Change limits" : "Set limits"}
                        </Link>
                      )}
                      {limitsFor === p.id && (
                        <KeptForm action={saveProjectCapsAction} className="bill-limits">
                          <input type="hidden" name="projectId" value={p.id} />
                          {CAP_UNITS.map((u) => (
                            <div key={u} className="field">
                              <label htmlFor={`cap-${p.id}-${u}`}>{CAP_WORDS[u].label} a month</label>
                              <input id={`cap-${p.id}-${u}`} name={u} type="text" inputMode="numeric" placeholder="No limit" defaultValue={caps.get(p.id)?.[u] ?? ""} />
                            </div>
                          ))}
                          <div className="bill-limits__acts">
                            <Link href={`/dashboard/settings/billing#p-${p.id}`} className="btn btn--light btn--sm">
                              Cancel
                            </Link>
                            <button type="submit" className="btn btn--ink btn--sm" data-save-limits>
                              Save limits
                            </button>
                          </div>
                        </KeptForm>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <div className="bill-grid">
            <section className="bill-wallet" data-billing-wallet>
              <div className="bill-wallet__head">
                <h2>Top-ups</h2>
                <span className="bill-wallet__hint">Used once a month&rsquo;s allowance runs out</span>
              </div>
              <ul className="bill-wallet__list">
                {o.wallet
                  .filter((w) => w.left > 0 || w.unit === "WHATSAPP")
                  .map((w) => (
                    <li key={w.unit} className={w.left > 0 ? undefined : "is-empty"} data-wallet={w.unit}>
                      <span className="bill-wallet__amount tnum">{w.left > 0 ? amountOf(w.unit, w.left) : `No ${UNIT_WORDS[w.unit].many}`}</span>
                      <span className="bill-wallet__when">
                        {w.left > 0
                          ? `until ${shortDate(w.lots[0].expiresAt)}${w.lots.length > 1 ? `, and ${w.lots.length - 1} more` : ""}`
                          : "Messages stop at zero"}
                        {w.lots.some((l) => l.test) && <span className="bill-wallet__test">Test</span>}
                      </span>
                    </li>
                  ))}
              </ul>
              {canBuy ? (
                <Link href="/dashboard/settings/billing/top-up" className="btn btn--light btn--sm">
                  Top up
                  <ArrowUpRight size={13} />
                </Link>
              ) : (
                <p className="bill-wallet__foot">
                  Ask us to add a top-up.
                  {canManage && (
                    <>
                      {" "}
                      <Link href="/dashboard/settings/billing/top-up">See the prices</Link>
                    </>
                  )}
                </p>
              )}
            </section>

            <div className="bill-side">
              <section className="card" data-billing-questions>
                <div className="card__head">
                  <h2>Ask Jimmy</h2>
                </div>
                <Meter label="Questions this month" used={o.questions.used} allowance={o.questions.allowance} />
                <p className="sub">Shared by everyone in {viewer.state.org.displayName}.</p>
              </section>
              {!editing && details}
            </div>
          </div>

          {editing && details}
        </>
      )}
    </>
  );
}
