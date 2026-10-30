import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { autoTopUpView } from "@/lib/auto-topup";
import { autoSkus, chargeWords, thresholdShown, thresholdUnitWords } from "@/lib/auto-topup-rules";
import { rupees, skuByKey } from "@/lib/billing-rules";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { PageHead } from "@/components/shell/PageHead";
import { Wallet } from "@/components/icons";
import { cancelAutoChargeAction, stopMandateAction } from "@/app/actions/billing";
import { mandateSetupState } from "@/lib/mandate-setup";
import { ConfirmAction } from "@/components/ConfirmAction";
import { MandateSetup } from "./MandateSetup";
import { BillingTabs } from "../BillingTabs";
import { AutoForm } from "./AutoForm";
import { PayCharge } from "./PayCharge";
import "../billing.css";

/**
 * Auto top-up. The setting opens read-only and Change is the one action at
 * the top. A top-up that needs the client (to pay it, or to stop one that
 * is about to be charged) sits on the dark card above everything else.
 */

const METHOD: Record<string, string> = { CARD: "Card", UPI: "UPI AutoPay", EMANDATE: "Bank e-mandate" };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export default async function AutoTopUpPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("billing:read")) redirect("/dashboard/settings");
  const canManage = viewer.authz.can("billing:manage");
  const [v, setup, params] = await Promise.all([autoTopUpView(viewer.state.org.id), mandateSetupState(viewer.state.org.id), searchParams]);
  const editing = canManage && params.edit === "1" && !!v.mode && !!v.buyerState;
  const sku = skuByKey(v.setting.sku ?? "");
  const s = v.setting;

  // With nothing in it yet, the history sits under Automatic payment.
  const history = (
          <section className={v.history.length ? "card bill-invoices auto-history" : "card auto-history"} data-auto-history>
            {v.history.length === 0 ? (
              <>
                <div className="card__head">
                  <h2>Automatic top-ups</h2>
                </div>
                <p className="sub">None yet.</p>
              </>
            ) : (
              <table className="bill-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Top-up</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {v.history.map((c) => {
                    const w = chargeWords(c.status, c.note);
                    return (
                      <tr key={c.id} data-auto-row={c.status}>
                        <td className="tnum">{day(c.createdAt)}</td>
                        <td>{c.label}</td>
                        <td className="num tnum">{rupees(c.totalPaise, true)}</td>
                        <td>
                          <span className={`pill pill--${w.tone}`}>{w.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
  );

  return (
    <>
      <PageHead
        title={
          <>
            Auto <span className="em">top-up</span>
          </>
        }
        meta={
          v.mode ? (
            <>
              {s.on ? "On" : "Off"}
              {v.mode === "SHADOW" && <span className="pill pill--quiet bill-mode">Not billed yet</span>}
            </>
          ) : (
            "No plan yet"
          )
        }
        action={
          canManage && v.mode && !editing ? (
            v.buyerState ? (
              <Link href="/dashboard/settings/billing/auto?edit=1" className="btn btn--ink" data-auto-change>
                Change
              </Link>
            ) : (
              <Link href="/dashboard/settings/billing?edit=details#details" className="btn btn--ink">
                Add billing details
              </Link>
            )
          ) : null
        }
      />
      <BillingTabs current="auto" canManage={canManage} />
      <Flash text={readFlash(params, "saved")} name="saved" tone="info" style={{ marginBottom: 16 }} />
      <Flash text={readFlash(params, "error")} name="error" style={{ marginBottom: 16 }} />

      {!v.mode ? (
        <section className="card empty" data-auto-none>
          <span className="empty__mark">
            <Wallet size={18} />
          </span>
          <h2>No plan yet</h2>
          <p className="sub">Automatic top-ups start once a project has a plan.</p>
        </section>
      ) : (
        <div className="stack">
          {v.open.length > 0 && (
            <section className="bill-wallet auto-open" data-auto-open>
              <div className="bill-wallet__head">
                <h2>Needs you</h2>
              </div>
              <ul className="bill-wallet__list">
                {v.open.map((c) => (
                  <li key={c.id} data-auto-charge={c.id} data-status={c.status}>
                    <span>
                      <span className="bill-wallet__amount tnum">{rupees(c.totalPaise, true)}</span>
                      <span className="auto-open__what">
                        {c.label}
                        {c.status === "NOTIFIED" && c.dueAt ? `, charged ${when(c.dueAt)}` : ""}
                        {c.status === "AWAITING_APPROVAL" ? ", waiting for you to pay" : ""}
                        {c.status === "CHARGING" ? ", being charged" : ""}
                      </span>
                    </span>
                    {canManage && c.status !== "CHARGING" && (
                      <span className="auto-open__acts">
                        {c.status === "AWAITING_APPROVAL" && <PayCharge chargeId={c.id} label={`Pay ${rupees(c.totalPaise, true)}`} />}
                        <form action={cancelAutoChargeAction}>
                          <input type="hidden" name="charge" value={c.id} />
                          <button type="submit" className="btn btn--ghost btn--sm auto-open__cancel" data-cancel-charge={c.id}>
                            Cancel
                          </button>
                        </form>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="pair pair--stretch">
          <section className={editing ? "card pair__wide" : "card"} data-auto-setting>
            <div className="card__head">
              <h2>Setting</h2>
              <span className={`pill ${s.on ? "pill--ok" : "pill--quiet"}`}>{s.on ? "On" : "Off"}</span>
            </div>
            {editing && v.buyerState ? (
              <AutoForm skus={autoSkus(v.hasScale)} setting={s} sellerState={v.sellerState} buyerState={v.buyerState} />
            ) : (
              <div className="facts bill-facts auto-facts">
                <div className="fact">
                  <div className="fact__k">Buys</div>
                  <div className="fact__v">{sku ? `${s.qty > 1 ? `${s.qty} x ` : ""}${sku.label}` : "Not chosen"}</div>
                </div>
                <div className="fact">
                  <div className="fact__k">When fewer than</div>
                  <div className="fact__v tnum">
                    {sku && s.threshold !== null
                      ? sku.unit === "WHATSAPP"
                        ? `${rupees(s.threshold)} of credit`
                        : `${thresholdShown(sku.unit, s.threshold).toLocaleString("en-IN")} ${thresholdUnitWords(sku.unit)}`
                      : "Not set"}
                  </div>
                </div>
                <div className="fact">
                  <div className="fact__k">Monthly limit</div>
                  <div className="fact__v tnum">
                    {s.ceilingPaise ? `${rupees(v.spentThisMonthPaise)} of ${rupees(s.ceilingPaise)} this month` : "Not set"}
                  </div>
                </div>
              </div>
            )}
          </section>

          <div className="stack">
          <section className="card auto-mandate-card" data-auto-mandate>
            <div className="card__head">
              <h2>Automatic payment</h2>
              {v.mandate ? (
                <span className="pill pill--ok">Set up</span>
              ) : setup.waiting ? (
                <span className="pill pill--warn">Bank confirming</span>
              ) : (
                <span className="pill pill--quiet">Not set up</span>
              )}
            </div>
            <p className="sub" data-mandate-state>
              {v.mandate
                ? `${v.mandate.label ?? METHOD[v.mandate.method] ?? v.mandate.method}, up to ${rupees(v.mandate.maxAmountPaise)} a time.`
                : setup.waiting
                  ? `${METHOD[setup.waiting.method]}: waiting for your bank to confirm it.`
                  : "Each top-up waits for you to pay it."}
            </p>
            {canManage && !setup.waiting && (setup.refusal ? <p className="sub">{setup.refusal}</p> : <MandateSetup label={v.mandate ? "Replace automatic payment" : "Set up automatic payment"} />)}
            {canManage && v.mandate && (
              <div className="auto-mandate-card__stop">
                <ConfirmAction
                  label="Stop automatic payment"
                  title="Stop automatic payment?"
                  body="Top-ups announced but not yet taken are cancelled, and each one after this waits for you to pay it."
                  confirmLabel="Stop automatic payment"
                  action={stopMandateAction}
                  fields={{}}
                  tone="ghost"
                  testId="mandate-stop"
                />
              </div>
            )}
          </section>
          {v.history.length === 0 && history}
          </div>
          </div>

          {v.history.length > 0 && history}
        </div>
      )}
    </>
  );
}
