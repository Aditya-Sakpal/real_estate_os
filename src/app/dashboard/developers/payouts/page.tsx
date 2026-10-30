import Link from "next/link";
import { redirect } from "next/navigation";
import { outsideDevelopers, outsideWork } from "@/lib/outside";
import { inr, showRate, daysFrom, UNPAID_LATE_DAYS } from "@/lib/outside-rules";
import { BookingForm, PaidForm, RowAction } from "../OutsideForms";
import { partnerWork } from "@/lib/partner-workspace";
import { getViewer } from "@/lib/console";
import { HALF_WORDS, partnerTotals, sentBackWords } from "@/lib/partner-workspace-rules";
import { istDay, ladder, netAfterAdjustments, pct } from "@/lib/partner-rules";
import { longDay } from "@/lib/mandate-rules";
import { rupees } from "@/lib/lead-rules";
import { PartnerHead } from "../PartnerHead";
import { SendInvoice } from "@/app/workspace/SendInvoice";
import "@/app/workspace/workspace.css";

/**
 * A channel partner's brokerage: what each booking owes it, by half. Each half says what it is
 * waiting on in the partner's words: not due yet and why, your invoice, the
 * developer's check, the approval, or paid with the bank's reference.
 */
export default async function PartnerPayouts({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (viewer.orgType !== "CHANNEL_PARTNER" || viewer.via || !viewer.authz.can("payout:read")) redirect("/dashboard/developers");
  const today = istDay(new Date().toISOString());
  const q = await searchParams;
  const one = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x);
  const [work, outside, outsideDevs] = await Promise.all([
    partnerWork(viewer.state.org.id),
    outsideWork(viewer.state.org.id, today),
    outsideDevelopers(viewer.state.org.id),
  ]);
  const totals = partnerTotals(work.bookings, today);
  const rms = new Map(work.developers.map((d) => [d.orgId, d.rm]));
  // Sending an invoice is the desk's own key for it; the amounts are already this page's.
  const mayInvoice = viewer.authz.can("partner:register");

  // Developers not on Sales Desk: the partner's own bookings and invoices.
  const outsideProjects = outsideDevs.flatMap((d) => d.projects.map((p) => ({ value: p.id, developer: d.name, project: p.name })));
  const recording = mayInvoice && one(q.record) === "new" && outsideProjects.length > 0;
  const paying = mayInvoice ? outside.bookings.find((b) => b.invoice && !b.invoice.paidOn && b.invoice.id === one(q.paid)) : undefined;
  const live = outside.bookings.filter((b) => !b.cancelled);
  const toInvoice = live.filter((b) => !b.invoice).reduce((n, b) => n + b.brokerage, 0);
  const unpaid = live.filter((b) => b.invoice && !b.invoice.paidOn).reduce((n, b) => n + (b.invoice!.total - b.invoice!.tds), 0);

  return (
    <>
      <PartnerHead
        current="payouts"
        meta={work.bookings.length === 0 ? "No booking yet" : `${totals.bookings} ${totals.bookings === 1 ? "booking" : "bookings"} · ${totals.toInvoice} ${totals.toInvoice === 1 ? "invoice" : "invoices"} to send`}
        counts={{ buyers: work.buyers.length, toInvoice: totals.toInvoice }}
        seesMoney
        canRegister={false}
      />

      <div className="fw-stack">
        {/* Three zeros say nothing a single line does not; the totals come with the first booking. */}
        {work.bookings.length > 0 && (
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

        <section className="card fw-card" aria-label="Commission by booking">
          <div className="fw-card__head">
            <h2>Brokerage by booking</h2>
            {work.bookings.length > 0 && <span className="fw-card__meta">Amounts after TDS</span>}
          </div>
          {work.bookings.length === 0 ? (
            <p className="fw-empty">When a buyer you registered books, the commission shows here, in two halves.</p>
          ) : (
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
                {work.bookings.map((b) => {
                  const rungs = ladder(b);
                  return (
                    <tr key={b.id}>
                      <td>
                        <span className="fw-book">
                          <span className="fw-book__what">
                            {b.buyer} · {b.place}
                            {b.unit ? ` · ${b.unit}` : ""}
                          </span>
                          <span className="fw-book__line">
                            {b.developer} · booked {longDay(b.bookedOn)} · {pct(b.rate - (b.passBack ?? 0))}
                          </span>
                          {b.clawback && b.clawback.amount > 0 && (
                            <span className="fw-book__line">
                              Cancelled after {rupees(b.clawback.amount)} was paid; it comes off your next payouts
                              {b.clawback.outstanding > 0 ? ` (${rupees(b.clawback.outstanding)} still to come off)` : ""}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="tnum">{rupees(b.agreement)}</td>
                      {rungs.map((r) => {
                        const words = HALF_WORDS[r.state];
                        const back = r.state === "no_invoice" ? b.progress[r.key]?.sentBack : null;
                        return (
                          <td key={r.key}>
                            <span className="fw-half">
                              <span className="tnum">{rupees(netAfterAdjustments(b, r.key, r.invoice.net))}</span>
                              {(b.adjusted?.[r.key] ?? []).map((a, i) => (
                                <span key={i} className="fw-book__line tnum">
                                  Adjusted against booking {a.against}: &minus; {rupees(a.amount)}
                                </span>
                              ))}
                              <span className={`pill pill--${back ? "risk" : words.tone}`}>
                                <span className="pill__dot" />
                                {r.state === "paid" && r.paidOn ? `Paid ${longDay(r.paidOn)}` : back ? "Sent back" : words.label}
                              </span>
                              {back && (
                                <span className="fw-book__line fw-book__line--risk" data-sent-back={r.key}>
                                  Invoice {back.no} sent back: {sentBackWords(back.reason)}. Send a corrected one.
                                </span>
                              )}
                              {r.state === "held" && r.why && <span className="fw-book__line">{r.why}</span>}
                              {r.state === "no_invoice" && (
                                <span className="fw-book__line">
                                  {rupees(r.invoice.gross)} to {rms.get(b.devOrgId) ?? "your relationship manager"}
                                </span>
                              )}
                              {r.state === "no_invoice" && mayInvoice && (
                                <SendInvoice
                                  payoutId={b.id}
                                  half={r.key}
                                  devOrgId={b.devOrgId}
                                  gross={r.invoice.gross.toLocaleString("en-IN")}
                                  what={`${b.buyer} · ${b.place} · ${b.developer} · ${r.key === "M1" ? "first" : "second"} half, ${rupees(r.invoice.gross)}`}
                                  today={today}
                                />
                              )}
                              {r.state === "paid" && r.utr && <span className="fw-book__line tnum">UTR {r.utr}</span>}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {totals.toInvoice > 0 && <p className="fw-foot">Invoice each half for the gross amount shown. The developer pays the net, after TDS.</p>}
        </section>

        {(outside.bookings.length > 0 || outsideProjects.length > 0) && (
          <section className="card fw-card" aria-label="Brokerage from developers not on Sales Desk">
            <div className="fw-card__head">
              <h2>From developers not on Sales Desk</h2>
              {mayInvoice && outsideProjects.length > 0 && !recording && (
                <Link href="/dashboard/developers/payouts?record=new" className="btn btn--ghost btn--sm" data-record-new>
                  Record a booking
                </Link>
              )}
            </div>

            {recording && (
              <BookingForm registrationId={null} projects={outsideProjects} today={today} defaultRate="" closeHref="/dashboard/developers/payouts" />
            )}

            {paying && paying.invoice && (
              <div className="fw-form-wrap">
                <h3 className="fw-sub">Payment for {paying.invoice.number}</h3>
                <PaidForm
                  invoiceId={paying.invoice.id}
                  today={today}
                  net={((paying.invoice.total - paying.invoice.tds) / 100).toLocaleString("en-IN")}
                  closeHref="/dashboard/developers/payouts"
                />
              </div>
            )}

            {live.length > 0 && (
              <p className="fw-buyer__line" style={{ margin: "0 0 10px" }}>
                To invoice {inr(toInvoice)} · Invoiced and unpaid, after TDS, {inr(unpaid)}
              </p>
            )}

            {outside.bookings.length === 0 ? (
              <p className="fw-empty">Record a booking, or mark a registered buyer booked, and its brokerage shows here.</p>
            ) : (
              <table className="fw-table fw-table--dense">
                <thead>
                  <tr>
                    <th scope="col">Booking</th>
                    <th scope="col">Agreement</th>
                    <th scope="col">Brokerage</th>
                    <th scope="col">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {outside.bookings.map((b) => {
                    const late = b.invoice && !b.invoice.paidOn && daysFrom(b.invoice.issuedOn, today) > UNPAID_LATE_DAYS;
                    return (
                      <tr key={b.id} data-outside-booking={b.id}>
                        <td>
                          <span className="fw-book">
                            <span className="fw-book__what">
                              {[b.buyer, b.project, b.unit].filter(Boolean).join(" · ")}
                            </span>
                            <span className="fw-book__line">
                              {b.developer} · booked {longDay(b.bookedOn)} · {showRate(b.rateBp)}
                            </span>
                          </span>
                        </td>
                        <td className="tnum">{inr(b.agreement)}</td>
                        <td className="tnum">{inr(b.brokerage)}</td>
                        <td>
                          {b.cancelled ? (
                            <span className="pill pill--quiet">Cancelled</span>
                          ) : b.invoice ? (
                            <span className="fw-half">
                              <a href={`/dashboard/developers/payouts/outside/${b.invoice.id}`} className="tnum" data-invoice-pdf={b.invoice.id}>
                                {b.invoice.number}
                              </a>
                              <span className="fw-book__line tnum">
                                {inr(b.invoice.total)} · {inr(b.invoice.total - b.invoice.tds)} after TDS
                              </span>
                              <span className={`pill pill--${b.invoice.paidOn ? "ok" : late ? "warn" : "blue"}`}>
                                <span className="pill__dot" />
                                {b.invoice.paidOn ? `Paid ${longDay(b.invoice.paidOn)}` : late ? "Unpaid, late" : "Sent, unpaid"}
                              </span>
                              {b.invoice.utr && <span className="fw-book__line tnum">UTR {b.invoice.utr}</span>}
                              {!b.invoice.paidOn && mayInvoice && (
                                <Link href={`/dashboard/developers/payouts?paid=${b.invoice.id}`} className="btn btn--ghost btn--sm" data-paid={b.invoice.id}>
                                  Record payment
                                </Link>
                              )}
                            </span>
                          ) : mayInvoice ? (
                            <span className="fw-rowacts" style={{ justifyContent: "flex-start" }}>
                              <RowAction label="Make invoice" run={{ kind: "invoice", bookingId: b.id }} tone="ink" testId="make-invoice" />
                              <RowAction label="Cancel booking" run={{ kind: "cancel", id: b.id }} testId="cancel-booking" />
                            </span>
                          ) : (
                            <span className="pill pill--quiet">Not invoiced</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>
    </>
  );
}
