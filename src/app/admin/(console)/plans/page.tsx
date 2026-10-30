import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { plansData } from "@/lib/admin-data";
import { day, KIND_WORDS, num, plural, PLAN_WORDS, rs, rsShort, words } from "../../fmt";
import { CardHead, Donut, Empty, Meter, Stat } from "../kit";

export default async function AdminPlans() {
  const p = await plansData();
  const value = p.subs.reduce((s, x) => s + x.pricePaise, 0);
  const thisMonth = p.subs.reduce((s, x) => s + x.thisMonthPaise, 0);
  const cost = p.subs.reduce((s, x) => s + x.fixedCostPaise + x.meteredCostPaise, 0);
  const paid = p.payments.filter((x) => x.status === "PAID" && !x.test).reduce((s, x) => s + x.totalPaise, 0);
  const margin = thisMonth > 0 ? 1 - cost / thisMonth : null;
  const mix = ["LAUNCH", "GROWTH", "SCALE"].map((k) => ({ label: PLAN_WORDS[k], n: p.subs.filter((s) => s.plan === k).length }));
  const under = p.subs.filter((s) => s.margin !== null && s.margin < p.floors.plan);

  return (
    <>
      <PageHead
        title={
          <>
            Plans and <span className="em">revenue</span>
          </>
        }
        meta={`${plural(p.subs.length, "plan")} running · ${plural(p.noPlan.length, "client")} with none · nothing is charged until a client is switched to live`}
      />

      <section className="adm-hero-row">
        <aside className="ws-dark adm-hero">
          <span className="ws-dark__label">Plan value a month</span>
          <span className="adm-hero__num tnum">{rsShort(value)}</span>
          <span className="ws-dark__sub">What the running plans list at, before GST</span>
          <div className="adm-hero__split">
            <div>
              <span className="ws-dark__label">Due this month</span>
              <strong className="tnum">{rsShort(thisMonth)}</strong>
            </div>
            <div>
              <span className="ws-dark__label">Margin this month</span>
              <strong className="tnum">{margin === null ? "None" : `${Math.round(margin * 100)}%`}</strong>
            </div>
          </div>
          <span className="ws-dark__foot">
            <span className="ws-dark__sub">Floors: {Math.round(p.floors.plan * 100)}% at full use, {Math.round(p.floors.worst * 100)}% worst case</span>
          </span>
        </aside>
        <div className="adm-stats">
          <Stat label="Plans running" value={num(p.subs.length)} sub={mix.map((m) => `${m.n} ${m.label}`).join(" · ")} />
          <Stat label="Real money received" value={rsShort(paid)} sub="Paid, not test" />
          <Stat label="Our cost on plans this month" value={rsShort(cost)} sub="Metered use plus lines, numbers and platform" />
          <Stat label="Under the margin floor" value={num(under.length)} sub={under.length ? under.map((u) => u.orgName).join(", ") : "Every plan is above 60%"} />
        </div>
      </section>

      <section className="card">
        <CardHead title="Every plan, and how much of it is used" sub="This month, in India time" />
        <div className="ws-scroll">
          <table className="ws-table adm-table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Plan</th>
                <th scope="col">For</th>
                <th scope="col">Since</th>
                <th scope="col" className="ws-num">A month</th>
                <th scope="col" className="ws-num">This month</th>
                <th scope="col" className="ws-num">Our cost</th>
                <th scope="col" className="ws-num">Margin</th>
                <th scope="col">Allowance used</th>
              </tr>
            </thead>
            <tbody>
              {p.subs.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={`/clients/${s.orgId}?tab=plan`} className="adm-who">
                      <span>
                        <strong>{s.orgName}</strong>
                        <small>{s.prepaid ? "Bought in the console" : "Set by us"}</small>
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span className="pill pill--blue">{s.label}</span>
                  </td>
                  <td>{s.scope === "ORG" ? "The whole firm" : (s.projectName ?? "A project")}</td>
                  <td>{s.startsOn}</td>
                  <td className="ws-num tnum">{rs(s.pricePaise)}</td>
                  <td className="ws-num tnum">{rs(s.thisMonthPaise)}</td>
                  <td className="ws-num tnum">{rs(s.fixedCostPaise + s.meteredCostPaise)}</td>
                  <td className="ws-num tnum">
                    <span className={s.margin !== null && s.margin < p.floors.plan ? "adm-bad" : "adm-good"}>
                      {s.margin === null ? "None" : `${Math.round(s.margin * 100)}%`}
                    </span>
                  </td>
                  <td className="adm-mini-meters">
                    {s.allowances.slice(0, 4).map((a) => (
                      <Meter key={a.unit} label={a.label} used={a.used} of={a.allowance} />
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!p.subs.length && <Empty>No plan is running.</Empty>}
        </div>
      </section>

      <section className="adm-three">
        <div className="card">
          <CardHead title="Plan mix" />
          <Donut parts={mix} centre={num(p.subs.length)} caption="plans" />
        </div>
        <div className="card adm-span2">
          <CardHead title="Clients with no plan" sub="Metered, never refused on account of billing" />
          <div className="ws-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="ws-num">Projects</th>
                </tr>
              </thead>
              <tbody>
                {p.noPlan.slice(0, 12).map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/clients/${o.id}`} className="adm-strong">
                        {o.name}
                      </Link>
                    </td>
                    <td>{KIND_WORDS[o.type] ?? o.type}</td>
                    <td className="ws-num tnum">{o.projects}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {p.noPlan.length > 12 && <p className="adm-foot">And {p.noPlan.length - 12} more.</p>}
          </div>
        </div>
      </section>

      <section className="adm-two">
        <div className="card">
          <CardHead title="Payments" sub="Newest first. Test payments are marked." />
          <div className="ws-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Client</th>
                  <th scope="col">For</th>
                  <th scope="col">State</th>
                  <th scope="col" className="ws-num">Total</th>
                </tr>
              </thead>
              <tbody>
                {p.payments.slice(0, 20).map((x, i) => (
                  <tr key={i}>
                    <td>{day(x.at)}</td>
                    <td>
                      <Link href={`/clients/${x.orgId}?tab=plan`} className="adm-strong">
                        {x.orgName}
                      </Link>
                    </td>
                    <td>
                      {x.purpose === "PLAN" ? `${PLAN_WORDS[x.plan ?? ""] ?? "A"} plan` : x.purpose === "TOPUP" ? "Top-up" : words({}, x.purpose)}{" "}
                      {x.test && <span className="pill pill--quiet">Test</span>}
                    </td>
                    <td>
                      <span className={`pill ${x.status === "PAID" ? "pill--ok" : "pill--quiet"}`}>{x.status === "PAID" ? "Paid" : x.status === "CREATED" ? "Not completed" : words({}, x.status)}</span>
                    </td>
                    <td className="ws-num tnum">{rs(x.totalPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!p.payments.length && <Empty>No payments yet.</Empty>}
          </div>
        </div>
        <div className="card">
          <CardHead title="Monthly renewals" sub="Shadow mode records what would be charged" />
          <ul className="adm-list">
            {p.renewals.map((r, i) => (
              <li key={i}>
                <span className="adm-list__main">
                  <strong>{r.orgName}</strong>
                  <small>{r.period}</small>
                </span>
                <span className="adm-list__end">
                  <strong className="tnum">{rs(r.totalPaise)}</strong>
                  <small>{r.status === "WOULD_CHARGE" ? "Would charge" : words({}, r.status)}</small>
                </span>
              </li>
            ))}
          </ul>
          {!p.renewals.length && <Empty>No renewal yet.</Empty>}
        </div>
      </section>
    </>
  );
}
