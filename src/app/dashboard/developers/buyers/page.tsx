import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { partnerWork } from "@/lib/partner-workspace";
import { BUYER_WORDS, canBook, partnerTotals, refusedWhy, sortBuyers } from "@/lib/partner-workspace-rules";
import { daysBetween, istDay, regState, validUntil } from "@/lib/partner-rules";
import { longDay } from "@/lib/mandate-rules";
import { partnerLoanLine } from "@/lib/loan-rules";
import { VISIT_SLOTS, showDate, showTime } from "@/lib/lead-rules";
import { PartnerHead } from "../PartnerHead";
import { BookForm, RegisterForm } from "./BuyerForms";
import { outsideDevelopers, outsideWork } from "@/lib/outside";
import { OUTSIDE_WORDS, showRate } from "@/lib/outside-rules";
import { BookingForm, OutsideRegisterForm, RowAction } from "../OutsideForms";
import "@/app/workspace/workspace.css";

/**
 * The buyers a channel partner registered with each developer: where each
 * registration stands and until when, and the visit booked for it.
 * Registering a buyer is the one action at the top; booking a visit is on
 * each live buyer's row. Numbers arrive masked from the server.
 */
export default async function PartnerBuyers({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (viewer.orgType !== "CHANNEL_PARTNER" || viewer.via) redirect("/dashboard/developers");
  if (!viewer.authz.can("partner:register") && !viewer.authz.can("partner:read")) redirect("/dashboard/developers");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const one = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x);
  const today = istDay(new Date().toISOString());
  const [work, outsideDevs, outside] = await Promise.all([partnerWork(orgId), outsideDevelopers(orgId), outsideWork(orgId, today)]);
  // Developers not on Sales Desk that say where they take registrations.
  const outsideProjects = outsideDevs
    .filter((d) => d.setup)
    .flatMap((d) => d.projects.map((p) => ({ value: p.id, developer: d.name, project: p.name })));
  const mayWork = viewer.authz.can("partner:register");
  const seesMoney = viewer.authz.can("payout:read");

  const show = one(q.show) === "booked" ? "booked" : one(q.show) === "all" ? "all" : "open";
  const all = sortBuyers(work.buyers, today);
  const open = all.filter((b) => ["live", "lapsing", "visited"].includes(regState(b, today)));
  const booked = all.filter((b) => regState(b, today) === "booked");
  const rows = show === "open" ? open : show === "booked" ? booked : all;
  const ending = open.filter((b) => regState(b, today) === "lapsing").length;

  const liveProjects = work.developers.flatMap((d) =>
    d.projects.filter((p) => p.status === "live").map((p) => ({ value: `${d.orgId}:${p.id}`, developer: d.name, project: p.name })),
  );
  const registering = mayWork && one(q.register) === "1" && (liveProjects.length > 0 || outsideProjects.length > 0);
  const recordFor = mayWork ? outside.registrations.find((r) => r.id === one(q.record) && r.canBook) : undefined;
  const recordRate = recordFor ? outsideDevs.find((d) => d.name === recordFor.developer)?.setup?.rateBp : undefined;
  const bookId = one(q.book);
  const booking = mayWork && bookId ? all.find((b) => b.id === bookId && canBook(b, today)) : undefined;
  const bookTowers = booking
    ? (work.developers.find((d) => d.orgId === booking.devOrgId)?.projects.find((p) => p.id === booking.projectId)?.towers ?? []).map((t) => ({
        value: `${booking.devOrgId}:${t.id}`,
        name: t.name,
      }))
    : [];

  const filter = (key: typeof show, label: string, n: number) => (
    <Link
      key={key}
      href={key === "open" ? "/dashboard/developers/buyers" : `/dashboard/developers/buyers?show=${key}`}
      className="seg__opt"
      aria-current={show === key ? "page" : undefined}
    >
      {label} <span className="tnum">{n}</span>
    </Link>
  );

  return (
    <>
      <PartnerHead
        current="buyers"
        meta={all.length === 0 ? "No buyer registered yet" : `${open.length} registered · ${ending} ending soon · ${booked.length} booked`}
        counts={{ buyers: work.buyers.length, toInvoice: partnerTotals(work.bookings, today).toInvoice }}
        seesMoney={seesMoney}
        canRegister={mayWork && (liveProjects.length > 0 || outsideProjects.length > 0) && !registering}
      />

      <div className="fw-stack">
        {registering && liveProjects.length > 0 && (
          <section className="card fw-card" aria-label="Register a buyer">
            <div className="fw-card__head">
              <h2>Register a buyer with a developer</h2>
            </div>
            <RegisterForm projects={liveProjects} />
          </section>
        )}

        {registering && outsideProjects.length > 0 && (
          <section className="card fw-card" aria-label="Register a buyer with a developer not on Sales Desk">
            <div className="fw-card__head">
              <h2>{liveProjects.length > 0 ? "With a developer not on Sales Desk" : "Register a buyer with a developer"}</h2>
              <span className="fw-card__meta">The developer is emailed from here</span>
            </div>
            <OutsideRegisterForm projects={outsideProjects} />
          </section>
        )}

        {recordFor && (
          <section className="card fw-card" aria-label="Record a booking">
            <div className="fw-card__head">
              <h2>{recordFor.buyer} booked</h2>
              <span className="fw-card__meta">
                {recordFor.developer} · {recordFor.project}
              </span>
            </div>
            <BookingForm registrationId={recordFor.id} projects={[]} today={today} defaultRate={recordRate ? showRate(recordRate).replace("%", "") : ""} closeHref="/dashboard/developers/payouts" />
          </section>
        )}

        {booking && (
          <section className="card fw-card" aria-label="Book a site visit">
            <div className="fw-card__head">
              <h2>Book a site visit for {booking.buyer}</h2>
              <span className="fw-card__meta">
                {booking.developer} · {booking.project} · registered until {longDay(validUntil(booking))}
              </span>
            </div>
            {bookTowers.length ? (
              <BookForm registrationId={booking.id} towers={bookTowers} slots={VISIT_SLOTS.map((s) => ({ value: s, label: showTime(s) }))} today={today} />
            ) : (
              <p className="fw-empty">{booking.project} has no tower open to visits yet.</p>
            )}
          </section>
        )}

        <section className="card fw-card" aria-label="Registered buyers">
          <div className="fw-card__head">
            {/* With no buyer at all, three filters that each read 0 choose nothing. */}
            {all.length === 0 ? (
              <h2>Registered buyers</h2>
            ) : (
              <div className="seg fw-seg" role="group" aria-label="Which buyers">
                {filter("open", "Registered", open.length)}
                {filter("booked", "Booked", booked.length)}
                {filter("all", "All", all.length)}
              </div>
            )}
          </div>
          {all.length === 0 ? (
            <p className="fw-empty">
              {liveProjects.length
                ? "Register a buyer here or from the lead's own page, on WhatsApp, or share your link and the buyer registers themselves."
                : "Once a developer empanels you, the buyers you register with it show here."}
            </p>
          ) : rows.length === 0 ? (
            <p className="fw-empty">{show === "booked" ? "No booking yet." : "No buyer registered right now."}</p>
          ) : (
            <table className="fw-table">
              <thead>
                <tr>
                  <th scope="col">Buyer</th>
                  <th scope="col">Project</th>
                  <th scope="col">Status</th>
                  <th scope="col">Registered until</th>
                  <th scope="col">Visit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const st = regState(b, today);
                  const until = b.refused ? null : validUntil(b);
                  const left = until ? daysBetween(today, until) : null;
                  return (
                    <tr key={b.id}>
                      <td>
                        <span className="fw-buyer">
                          <span className="fw-buyer__name">{b.buyer}</span>
                          <span className="fw-buyer__line tnum">{b.phone}</span>
                        </span>
                      </td>
                      <td>
                        <span className="fw-buyer">
                          <span>{b.project}</span>
                          <span className="fw-buyer__line">{b.developer}</span>
                        </span>
                      </td>
                      <td>
                        <span className={`pill pill--${BUYER_WORDS[st].tone}`}>
                          <span className="pill__dot" />
                          {BUYER_WORDS[st].label}
                        </span>
                        {b.refused && <div className="fw-buyer__line">{refusedWhy(b.refused.reason, b.refused.heldUntil, longDay)}</div>}
                        {partnerLoanLine(b.loanStage) && <div className="fw-buyer__line">{partnerLoanLine(b.loanStage)}</div>}
                      </td>
                      <td className="tnum">
                        {until && st !== "booked" ? (
                          <span className="fw-buyer">
                            <span>{longDay(until)}</span>
                            {left !== null && left >= 0 && st !== "lapsed" && (
                              <span className="fw-buyer__line">{left === 0 ? "Last day" : `${left} ${left === 1 ? "day" : "days"} left`}</span>
                            )}
                          </span>
                        ) : st === "booked" && b.bookedOn ? (
                          `Booked ${longDay(b.bookedOn)}`
                        ) : (
                          ""
                        )}
                      </td>
                      <td>
                        {b.visit ? (
                          <span className="fw-buyer">
                            <span>
                              {showDate(b.visit.day)}, {showTime(b.visit.time)}
                            </span>
                            <span className="fw-buyer__line">{b.visit.tower}</span>
                          </span>
                        ) : b.visitedOn ? (
                          <span className="fw-buyer__line">Visited {longDay(b.visitedOn)}</span>
                        ) : mayWork && canBook(b, today) ? (
                          <Link href={`/dashboard/developers/buyers?book=${b.id}`} className="btn btn--ghost btn--sm">
                            Book a visit
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {outside.registrations.length > 0 && (
          <section className="card fw-card" aria-label="With developers not on Sales Desk">
            <div className="fw-card__head">
              <h2>With developers not on Sales Desk</h2>
              <span className="fw-card__meta">{outside.registrations.length} registered</span>
            </div>
            <table className="fw-table">
              <thead>
                <tr>
                  <th scope="col">Buyer</th>
                  <th scope="col">Project</th>
                  <th scope="col">Status</th>
                  <th scope="col">Registered until</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {outside.registrations.map((r) => (
                  <tr key={r.id} data-outside-registration={r.id}>
                    <td>
                      <span className="fw-buyer">
                        <span className="fw-buyer__name">{r.buyer}</span>
                        <span className="fw-buyer__line tnum">{r.phone}</span>
                      </span>
                    </td>
                    <td>
                      <span className="fw-buyer">
                        <span>{r.project}</span>
                        <span className="fw-buyer__line">{r.developer}</span>
                      </span>
                    </td>
                    <td>
                      <span className={`pill pill--${OUTSIDE_WORDS[r.state].tone}`}>
                        <span className="pill__dot" />
                        {OUTSIDE_WORDS[r.state].label}
                      </span>
                      {r.mailError && r.canAnswer && <div className="fw-buyer__line">The email did not go</div>}
                    </td>
                    <td className="tnum">{["booked", "refused", "withdrawn", "erased"].includes(r.state) ? "" : longDay(r.validUntil)}</td>
                    <td>
                      {mayWork && (
                        <span className="fw-rowacts">
                          {r.canAnswer && r.mailError && <RowAction label="Send again" run={{ kind: "resend", id: r.id }} tone="ink" testId="resend" />}
                          {r.canAnswer && !r.mailError && <RowAction label="Confirmed" run={{ kind: "answer", id: r.id, answer: "CONFIRMED" }} testId="confirmed" />}
                          {r.canAnswer && !r.mailError && <RowAction label="Refused" run={{ kind: "answer", id: r.id, answer: "REFUSED" }} testId="refused" />}
                          {r.canBook && (
                            <Link href={`/dashboard/developers/buyers?record=${r.id}`} className="btn btn--ghost btn--sm" data-record={r.id}>
                              Booked
                            </Link>
                          )}
                        </span>
                      )}
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
