import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { leadsData } from "@/lib/admin-data";
import { CHANNEL_WORDS, num, pct, VISIT_WORDS, words } from "../../fmt";
import { CardHead, Columns, ColumnsKey, Delta, Donut, Empty, Stat } from "../kit";

export default async function AdminLeads() {
  const l = await leadsData();
  const f = l.funnel;
  const drops = f.slice(1).map((s, i) => ({ key: s.key, rate: f[i].n ? s.n / f[i].n : 0 }));
  const worst = drops.reduce((w, d) => (d.rate < w.rate ? d : w), drops[0]);
  const visitsMonth = l.visits.reduce((s, v) => s + v.n, 0);

  return (
    <>
      <PageHead
        title={
          <>
            Leads, from enquiry to <span className="em">booking</span>
          </>
        }
        meta="Every client's leads together. Test companies are left out."
      />

      <section className="adm-stats adm-stats--4">
        <Stat label="New leads this month" value={num(l.monthNew)} delta={<Delta now={l.monthNew} before={l.lastMonthNew} />} />
        <Stat label="Site visits this month" value={num(visitsMonth)} sub={l.visits.map((v) => `${v.n} ${words(VISIT_WORDS, v.status).toLowerCase()}`).join(" · ") || "None booked"} />
        <Stat label="Bookings this month" value={num(l.bookedMonth)} sub="Recorded as booked" />
        <Stat label="Booked of all leads" value={pct(f[4].n, f[0].n)} sub={`${num(f[4].n)} of ${num(f[0].n)} leads ever`} />
      </section>

      <section className="card">
        <CardHead title="Every lead, step by step" sub="How far each lead ever got, all time" />
        <ol className="rp-steps adm-steps">
          {f.map((s, i) => (
            <li key={s.key} className={`rp-step${s.key === "booked" ? " is-key" : ""}`}>
              {i > 0 && (
                <span className={`rp-conv${s.key === worst.key ? " is-drop" : ""}`}>
                  <span className="rp-conv__pct tnum">{pct(s.n, f[i - 1].n)}</span>
                  {s.key === worst.key && <span className="rp-conv__tag">Biggest drop</span>}
                </span>
              )}
              <span className="rp-step__label">{s.label}</span>
              <span className="rp-step__num tnum">{num(s.n)}</span>
              <span className="rp-step__cost">{pct(s.n, f[0].n)} of all</span>
              <span className="rp-step__bar" aria-hidden>
                <span style={{ width: `${f[0].n ? Math.max(1.5, (s.n / f[0].n) * 100) : 0}%` }} />
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="adm-two">
        <div className="card">
          <CardHead title="Leads a day" sub="Last 30 days" />
          <Columns days={l.daily} a="leads" b="booked" />
          <ColumnsKey a="Leads" b="Booked since" />
        </div>
        <div className="card">
          <CardHead title="Where this month's leads came from" />
          <Donut parts={l.channels.map((c) => ({ label: words(CHANNEL_WORDS, c.channel), n: c.n }))} centre={num(l.monthNew)} caption="leads" />
        </div>
      </section>

      <section className="card">
        <CardHead title="By client" sub="Qualified, visited and booked count every lead that ever got there" />
        <div className="ws-scroll">
          <table className="ws-table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col" className="ws-num">This month</th>
                <th scope="col" className="ws-num">All leads</th>
                <th scope="col" className="ws-num">Qualified</th>
                <th scope="col" className="ws-num">Visited</th>
                <th scope="col" className="ws-num">Booked</th>
                <th scope="col" className="ws-num">Lead to booking</th>
              </tr>
            </thead>
            <tbody>
              {l.byClient.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/clients/${c.id}?tab=sales`} className="adm-strong">
                      {c.name}
                    </Link>
                  </td>
                  <td className="ws-num tnum">{num(c.month)}</td>
                  <td className="ws-num tnum">{num(c.all)}</td>
                  <td className="ws-num tnum">{num(c.qualified)}</td>
                  <td className="ws-num tnum">{num(c.visits)}</td>
                  <td className="ws-num tnum">{num(c.booked)}</td>
                  <td className="ws-num tnum">{pct(c.booked, c.all)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!l.byClient.length && <Empty>No leads yet.</Empty>}
        </div>
      </section>
    </>
  );
}
