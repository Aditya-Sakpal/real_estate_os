import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { KINDS, usageData } from "@/lib/admin-data";
import { monthShort, num, rs, rsShort } from "../../fmt";
import { CardHead, CellBar, Columns, Delta, Donut, Empty, Stat } from "../kit";

export default async function AdminUsage() {
  const u = await usageData();
  const month = u.usage.reduce((s, x) => s + x.costPaise, 0);
  const last = u.usage.reduce((s, x) => s + x.lastMonthCostPaise, 0);
  const week = u.dailyCost.slice(-7).reduce((s, d) => s + d.a, 0);
  const maxTrend = Math.max(1, ...u.trend.map((t) => t.costPaise));
  const maxClient = Math.max(1, ...u.byClient.map((c) => c.costPaise));
  const maxKind = Math.max(1, ...u.usage.map((x) => x.costPaise));

  return (
    <>
      <PageHead
        title={
          <>
            Usage and <span className="em">cost</span>
          </>
        }
        meta="Our cost is estimated from what was made, at the unit costs in the price list. Test companies are left out."
      />

      <section className="adm-stats adm-stats--4">
        <Stat label="Our cost this month" value={rsShort(month)} delta={<Delta now={month} before={last} upIsGood={false} />} />
        <Stat label="Last 7 days" value={rsShort(week)} sub={`About ${rsShort(week / 7)} a day`} />
        <Stat label="Last month" value={rsShort(last)} />
        <Stat label="Clients using paid services" value={num(u.byClient.filter((c) => c.costPaise > 0).length)} sub="This month" />
      </section>

      <section className="adm-two">
        <div className="card">
          <CardHead title="Our cost a day" sub="Last 30 days" />
          <Columns days={u.dailyCost} a="" money />
        </div>
        <div className="card">
          <CardHead title="By vendor" sub="This month" />
          <Donut parts={u.byVendor.map((v) => ({ label: v.vendor, n: v.costPaise }))} centre={rsShort(month).replace("Rs ", "")} caption="rupees" money />
        </div>
      </section>

      <section className="card">
        <CardHead title="What was made, and what it cost us" sub="This month against last month" />
        <div className="ws-scroll">
          <table className="ws-table adm-table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Paid to</th>
                <th scope="col" className="ws-num">Made</th>
                <th scope="col" className="ws-num">Last month</th>
                <th scope="col">Our cost</th>
                <th scope="col" className="ws-num">Each</th>
                <th scope="col" className="ws-num">Last month&apos;s cost</th>
              </tr>
            </thead>
            <tbody>
              {u.usage.map((x) => (
                <tr key={x.kind}>
                  <td>
                    <strong>{KINDS[x.kind]?.label ?? x.kind}</strong>
                  </td>
                  <td className="adm-faint">{KINDS[x.kind]?.vendor}</td>
                  <td className="ws-num tnum">{num(x.made)}</td>
                  <td className="ws-num tnum">{num(x.lastMonthMade)}</td>
                  <td>
                    <CellBar value={x.costPaise} max={maxKind} label={rs(x.costPaise)} />
                  </td>
                  <td className="ws-num tnum">{x.made ? rs(x.costPaise / x.made) : "-"}</td>
                  <td className="ws-num tnum">{rs(x.lastMonthCostPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!u.usage.length && <Empty>Nothing metered yet.</Empty>}
        </div>
      </section>

      <section className="adm-two">
        <div className="card">
          <CardHead title="By client" sub="This month" />
          <div className="ws-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Our cost</th>
                  <th scope="col" className="ws-num">Last month</th>
                  <th scope="col">Most of it</th>
                </tr>
              </thead>
              <tbody>
                {u.byClient.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/clients/${c.id}?tab=plan`} className="adm-strong">
                        {c.name}
                      </Link>
                    </td>
                    <td>
                      <CellBar value={c.costPaise} max={maxClient} label={rsShort(c.costPaise)} />
                    </td>
                    <td className="ws-num tnum">{rsShort(c.lastMonthPaise)}</td>
                    <td className="adm-faint">{c.top ? (KINDS[c.top]?.label ?? c.top) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <CardHead title="Costliest projects" sub="This month" />
          <ul className="adm-list">
            {u.byProject.map((p, i) => (
              <li key={i}>
                <span className="adm-list__main">
                  <strong>{p.name}</strong>
                  <small>{p.orgName}</small>
                </span>
                <span className="adm-list__end">
                  <strong className="tnum">{rsShort(p.costPaise)}</strong>
                </span>
              </li>
            ))}
          </ul>
          {!u.byProject.length && <Empty>Nothing yet.</Empty>}
          <CardHead title="Our cost by month" />
          <div className="adm-months">
            {u.trend.map((t, i) => (
              <div key={t.period} className={`adm-month${i === u.trend.length - 1 ? " is-now" : ""}`}>
                <span className="adm-month__v tnum">{rsShort(t.costPaise)}</span>
                <span className="adm-month__bar">
                  <span style={{ height: `${Math.max(2, (t.costPaise / maxTrend) * 100)}%` }} />
                </span>
                <span className="adm-month__l">{monthShort(t.period)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
