import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { Alert, ArrowUpRight, Wallet } from "@/components/icons";
import { KINDS, overviewData, vendorsData } from "@/lib/admin-data";
import { ago, KIND_WORDS, num, pct, plural, rsShort } from "../fmt";
import { CardHead, Columns, ColumnsKey, Delta, Donut, GoLink, Stat } from "./kit";

export default async function AdminOverview() {
  const [o, vendors] = await Promise.all([overviewData(), vendorsData()]);
  const c = o.clients;
  const sum = (f: (x: (typeof c)[number]) => number) => c.reduce((s, x) => s + f(x), 0);

  const planValue = sum((x) => x.planValuePaise);
  const paid = sum((x) => x.paidPaise);
  const onPlan = c.filter((x) => x.plans.length).length;
  const projectsOnPlan = c.reduce((s, x) => s + x.plans.length, 0);
  const active30 = c.filter((x) => x.lastActivity && Date.now() - x.lastActivity.getTime() < 30 * 86_400_000).length;
  const leadsMonth = sum((x) => x.leadsMonth);
  const callsMonth = sum((x) => x.callsMonth);
  const connectedMonth = sum((x) => x.connectedMonth);
  const costMonth = sum((x) => x.costMonthPaise);
  const costLast = sum((x) => x.costLastMonthPaise);
  const days30 = (k: "leads" | "calls", f: "a" | "b") => o.daily[k].reduce((s, d) => s + d[f], 0);

  const h = o.health;
  const needs: { text: string; sub: string; href: string; external?: boolean }[] = [
    ...vendors
      .filter((v) => v.state === "low")
      .map((v) => ({
        text: `${v.name} balance is low: ${v.balance}`,
        sub: v.daysLeft === 0 ? `Runs out within a day at last week's pace. ${v.forWhat}.` : v.daysLeft !== null ? `About ${plural(v.daysLeft, "day")} left at last week's pace. ${v.forWhat}.` : v.forWhat,
        href: v.link,
        external: true,
      })),
    ...(h.callsSystemFailure7d
      ? [{ text: `${plural(h.callsSystemFailure7d, "call")} failed on our side this week`, sub: "Sarvam or our webhook. They used none of the buyers' tries.", href: "/health" }]
      : []),
    ...(h.reelFailed7d ? [{ text: `${plural(h.reelFailed7d, "video")} failed in the last 7 days`, sub: "Clients saw a failed card.", href: "/content" }] : []),
    ...(h.publishFailed ? [{ text: `${plural(h.publishFailed, "post or ad", "posts or ads")} failed to publish`, sub: "Meta or Google refused them.", href: "/health" }] : []),
    ...(h.messagesFailed7d ? [{ text: `${plural(h.messagesFailed7d, "WhatsApp message")} failed this week`, sub: "Mostly templates Meta has not approved.", href: "/health" }] : []),
    ...(h.connectionsBroken ? [{ text: `${plural(h.connectionsBroken, "connection")} to Meta or Google broken`, sub: "The client has to reconnect.", href: "/health" }] : []),
    ...(h.crmDead ? [{ text: `${plural(h.crmDead, "CRM write")} gave up`, sub: "Leads not in the client's CRM.", href: "/health" }] : []),
  ];

  const top = [...c].filter((x) => x.costMonthPaise > 0).sort((a, b) => b.costMonthPaise - a.costMonthPaise).slice(0, 6);
  const topMax = Math.max(1, ...top.map((x) => x.costMonthPaise));
  const byKind = (["DEVELOPER", "MANDATE_FIRM", "CHANNEL_PARTNER"] as const).map((k) => ({ label: KIND_WORDS[k], n: c.filter((x) => x.type === k).length }));
  const usageTop = o.usage.slice(0, 5).map((u) => ({ label: KINDS[u.kind]?.label ?? u.kind, n: u.costPaise }));
  const usageRest = o.usage.slice(5).reduce((s, u) => s + u.costPaise, 0);

  return (
    <>
      <PageHead
        title={
          <>
            The business, <span className="em">today</span>
          </>
        }
        meta={`${plural(c.length, "client")} · ${onPlan} on a plan · ${plural(o.newClients30d, "new client")} in 30 days${o.testCount ? ` · ${plural(o.testCount, "test company", "test companies")} left out` : ""}`}
        action={<GoLink href="/clients">All clients</GoLink>}
      />

      <section className="adm-hero-row">
        <aside className="ws-dark adm-hero">
          <span className="ws-dark__label">Plan value a month</span>
          <span className="adm-hero__num tnum">{rsShort(planValue)}</span>
          <span className="ws-dark__sub">
            {plural(projectsOnPlan, "plan")} across {plural(onPlan, "client")}
          </span>
          <div className="adm-hero__split">
            <div>
              <span className="ws-dark__label">Actually paid so far</span>
              <strong className="tnum">{rsShort(paid)}</strong>
            </div>
            <div>
              <span className="ws-dark__label">Our cost this month</span>
              <strong className="tnum">{rsShort(costMonth)}</strong>
            </div>
          </div>
          <span className="ws-dark__foot">
            <span className="ws-dark__sub">Shadow mode: nothing is charged yet</span>
            <Link className="ws-dark__cta" href="/plans">
              Plans
              <ArrowUpRight size={13} />
            </Link>
          </span>
        </aside>
        <div className="adm-stats">
          <Stat label="Active clients" value={num(active30)} sub={`of ${num(c.length)}, did work in 30 days`} href="/clients" />
          <Stat
            label="Leads this month"
            value={num(leadsMonth)}
            sub={`${num(o.today.leads)} today`}
            href="/leads"
          />
          <Stat
            label="AI calls this month"
            value={num(callsMonth)}
            sub={`${pct(connectedMonth, callsMonth)} picked up · ${num(o.today.calls)} today`}
            href="/calls"
          />
          <Stat
            label="Our cost this month"
            value={rsShort(costMonth)}
            delta={<Delta now={costMonth} before={costLast} upIsGood={false} />}
            href="/usage"
          />
        </div>
      </section>

      <section className="adm-two">
        <div className="pub-needs adm-needs">
          <div className="pub-needs__head">
            <h2>Needs attention</h2>
            <span className="pub-needs__n tnum">{needs.length}</span>
          </div>
          {needs.length ? (
            <ul className="pub-needs__list">
              {needs.slice(0, 7).map((x) => (
                <li key={x.text} className="pub-needs__item">
                  <span className="pub-needs__mark">
                    <Alert size={13} />
                  </span>
                  <span className="pub-needs__what">
                    <strong>{x.text}</strong>
                    <small>{x.sub}</small>
                  </span>
                  {x.external ? (
                    <a href={x.href} target="_blank" rel="noreferrer" className="btn btn--light btn--sm">
                      Top up
                    </a>
                  ) : (
                    <Link href={x.href} className="btn btn--light btn--sm">
                      Open
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="adm-dark-faint">Nothing needs you right now.</p>
          )}
        </div>

        <div className="card">
          <CardHead title="Vendor balances" sub="Live where the vendor publishes one" action={<GoLink href="/vendors">Vendors</GoLink>} />
          <ul className="adm-list">
            {vendors.slice(0, 5).map((v) => (
              <li key={v.name}>
                <span className={`adm-vdot adm-vdot--${v.state}`} aria-hidden>
                  <Wallet size={13} />
                </span>
                <span className="adm-list__main">
                  <strong>{v.name}</strong>
                  <small>{v.forWhat}</small>
                </span>
                <span className="adm-list__end">
                  <strong className="tnum">{v.balance ?? "Dashboard only"}</strong>
                  <small>
                    {v.state === "low" ? (
                      <span className="pill pill--risk">Low</span>
                    ) : v.daysLeft !== null ? (
                      `${num(v.daysLeft)} days at this pace`
                    ) : v.meteredMonthPaise ? (
                      `${rsShort(v.meteredMonthPaise)} this month`
                    ) : (
                      ""
                    )}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="adm-two adm-two--even">
        <div className="card">
          <CardHead title="Leads a day" sub={`${num(days30("leads", "a"))} in 30 days · ${num(days30("leads", "b"))} of them booked`} action={<GoLink href="/leads">Leads</GoLink>} />
          <Columns days={o.daily.leads} a="leads" b="booked" />
          <ColumnsKey a="Leads" b="Booked" />
        </div>
        <div className="card">
          <CardHead
            title="AI calls a day"
            sub={`${num(days30("calls", "a"))} in 30 days · ${pct(days30("calls", "b"), days30("calls", "a"))} picked up`}
            action={<GoLink href="/calls">AI calls</GoLink>}
          />
          <Columns days={o.daily.calls} a="calls" b="picked up" />
          <ColumnsKey a="Placed" b="Picked up" />
        </div>
      </section>

      <section className="adm-three">
        <div className="card">
          <CardHead title="Clients by kind" />
          <Donut parts={byKind} centre={num(c.length)} caption="clients" />
        </div>
        <div className="card">
          <CardHead title="Where our cost goes" sub="This month, estimated from what was made" />
          <Donut parts={[...usageTop, ...(usageRest ? [{ label: "Everything else", n: usageRest }] : [])]} centre={rsShort(costMonth).replace("Rs ", "")} caption="rupees" money />
        </div>
        <div className="card">
          <CardHead title="Costliest clients" sub="This month" action={<GoLink href="/usage">Usage</GoLink>} />
          <ul className="adm-rank">
            {top.map((x) => (
              <li key={x.id}>
                <Link href={`/clients/${x.id}`} className="adm-rank__name">
                  <strong>{x.name}</strong>
                  <small>
                    {KIND_WORDS[x.type]} · {x.lastActivity ? `active ${ago(x.lastActivity)}` : "never active"}
                  </small>
                </Link>
                <span className="adm-rank__bar">
                  <span style={{ width: `${Math.max(2, (x.costMonthPaise / topMax) * 100)}%` }} />
                </span>
                <span className="adm-rank__v tnum">{rsShort(x.costMonthPaise)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
