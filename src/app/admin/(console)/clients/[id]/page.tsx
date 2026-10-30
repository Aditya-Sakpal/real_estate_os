import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/shell/PageHead";
import { SubTabs } from "@/components/shell/SubTabs";
import { Board, Campaign, Clock, Headset, Inbox, Receipt, Team } from "@/components/icons";
import { clientDetail, KINDS } from "@/lib/admin-data";
import {
  ago,
  AGENT_WORDS,
  CHANNEL_WORDS,
  day,
  DEST_WORDS,
  KIND_WORDS,
  monthShort,
  num,
  OUTCOME_WORDS,
  pct,
  plural,
  PLAN_WORDS,
  POST_KIND_WORDS,
  roleWords,
  rs,
  rsShort,
  STAGE_WORDS,
  words,
} from "../../../fmt";
import { CardHead, CellBar, Columns, ColumnsKey, Delta, Donut, Empty, Meter, Stat } from "../../kit";
import { saveNoteAction } from "./actions";

const TABS = [
  { key: "overview", label: "Overview", icon: <Inbox size={14} /> },
  { key: "plan", label: "Plan and usage", icon: <Receipt size={14} /> },
  { key: "sales", label: "Leads and calls", icon: <Headset size={14} /> },
  { key: "content", label: "Posts and videos", icon: <Campaign size={14} /> },
  { key: "people", label: "People and accounts", icon: <Team size={14} /> },
  { key: "activity", label: "Activity and notes", icon: <Clock size={14} /> },
] as const;

const STAGES = ["new", "contacted", "qualified", "visit_scheduled", "visit_done", "negotiation", "booked", "nurture", "lost"];

export default async function AdminClient({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; saved?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "overview";
  const d = await clientDetail(id);
  if (!d) notFound();
  const c = d.client;
  const stageN = Object.fromEntries(d.stages.map((s) => [s.stage, s.n]));
  const leads30 = d.daily.leads.reduce((s, x) => s + x.a, 0);
  const calls30 = d.daily.calls.reduce((s, x) => s + x.a, 0);
  const picked30 = d.daily.calls.reduce((s, x) => s + x.b, 0);
  const maxTrend = Math.max(1, ...d.trend.map((t) => t.costPaise));
  const monthCost = d.subs.reduce((s, x) => s + x.thisMonthPaise, 0);

  return (
    <>
      <PageHead
        back={{ label: "Clients", href: "/clients" }}
        title={c.name}
        meta={
          <>
            <span className="pill pill--blue">{KIND_WORDS[c.type] ?? c.type}</span>{" "}
            {c.isTest && <span className="pill pill--warn">Test company</span>} {c.status !== "ACTIVE" && <span className="pill pill--quiet">Not claimed</span>}{" "}
            {c.legalName && c.legalName !== c.name ? `${c.legalName} · ` : ""}Joined {day(c.createdAt)} · {c.lastActivity ? `last active ${ago(c.lastActivity)}` : "no activity yet"} · billing{" "}
            {c.billingMode === "LIVE" ? "live" : c.billingMode ? "in shadow mode" : "not set up"}
          </>
        }
      />
      <SubTabs
        label="Client"
        current={`/clients/${id}?tab=${tab}`}
        items={TABS.map((t) => ({ href: `/clients/${id}?tab=${t.key}`, label: t.label, icon: t.icon }))}
      />

      {tab === "overview" && (
        <>
          <section className="adm-hero-row">
            <aside className="ws-dark adm-hero">
              <span className="ws-dark__label">Plan value a month</span>
              <span className="adm-hero__num tnum">{c.planValuePaise ? rsShort(c.planValuePaise) : "No plan"}</span>
              <span className="ws-dark__sub">
                {c.plans.length ? c.plans.map((p) => PLAN_WORDS[p.plan] ?? p.plan).join(", ") : "Nothing sold yet"}
              </span>
              <div className="adm-hero__split">
                <div>
                  <span className="ws-dark__label">Paid so far</span>
                  <strong className="tnum">{rsShort(c.paidPaise)}</strong>
                </div>
                <div>
                  <span className="ws-dark__label">Our cost this month</span>
                  <strong className="tnum">{rsShort(c.costMonthPaise)}</strong>
                </div>
              </div>
              <span className="ws-dark__foot">
                <span className="ws-dark__sub">{rsShort(c.costAllPaise)} of our cost in all</span>
                <Link className="ws-dark__cta" href={`/clients/${id}?tab=plan`}>
                  Plan and usage
                </Link>
              </span>
            </aside>
            <div className="adm-stats">
              <Stat label="Leads this month" value={num(c.leadsMonth)} sub={`${num(c.leadsAll)} in all · ${num(c.bookedAll)} booked`} href={`/clients/${id}?tab=sales`} />
              <Stat label="AI calls this month" value={num(c.callsMonth)} sub={`${pct(c.connectedMonth, c.callsMonth)} picked up · ${num(c.callMinutesMonth)} min`} href={`/clients/${id}?tab=sales`} />
              <Stat label="Posts and videos" value={num(c.postsMonth + c.videosMonth)} sub={`${num(c.postsMonth)} posts · ${num(c.videosMonth)} videos this month`} href={`/clients/${id}?tab=content`} />
              <Stat
                label="Our cost this month"
                value={rsShort(c.costMonthPaise)}
                delta={<Delta now={c.costMonthPaise} before={c.costLastMonthPaise} upIsGood={false} />}
                href={`/clients/${id}?tab=plan`}
              />
            </div>
          </section>

          <section className="adm-two adm-two--even">
            <div className="card">
              <CardHead title="Leads a day" sub={`${num(leads30)} in 30 days`} />
              <Columns days={d.daily.leads} a="leads" b="booked" height={140} />
              <ColumnsKey a="Leads" b="Booked" />
            </div>
            <div className="card">
              <CardHead title="AI calls a day" sub={`${num(calls30)} in 30 days · ${pct(picked30, calls30)} picked up`} />
              <Columns days={d.daily.calls} a="calls" b="picked up" height={140} />
              <ColumnsKey a="Placed" b="Picked up" />
            </div>
          </section>

          <section className="card">
            <CardHead
              title="Projects"
              sub={plural(d.projects.length, "project")}
              action={c.note ? <span className="pill pill--warn adm-note-pill" title={c.note}>Note: {c.note.length > 60 ? `${c.note.slice(0, 60)}...` : c.note}</span> : undefined}
            />
            <ProjectsTable d={d} />
          </section>
        </>
      )}

      {tab === "plan" && (
        <>
          {d.subs.length ? (
            <section className="adm-subs">
              {d.subs.map((s) => (
                <div key={s.id} className="card adm-sub">
                  <CardHead
                    title={
                      <>
                        {s.label} <span className="em">plan</span>
                      </>
                    }
                    sub={`${s.scope === "ORG" ? "The whole firm" : (s.projectName ?? "A project")} · since ${s.startsOn}${s.endsOn ? ` · ends ${s.endsOn}` : ""}`}
                    action={
                      s.ended ? (
                        <span className="pill pill--quiet">Ended</span>
                      ) : (
                        <span className={`pill ${s.prepaid ? "pill--ok" : "pill--quiet"}`}>{s.prepaid ? "Bought in the console" : "Set by us"}</span>
                      )
                    }
                  />
                  <div className="adm-sub__money">
                    <div>
                      <span>A month</span>
                      <strong className="tnum">{rs(s.pricePaise)}</strong>
                    </div>
                    <div>
                      <span>This month</span>
                      <strong className="tnum">{rs(s.thisMonthPaise)}</strong>
                    </div>
                    <div>
                      <span>Our cost</span>
                      <strong className="tnum">{rs(s.fixedCostPaise + s.meteredCostPaise)}</strong>
                    </div>
                    <div>
                      <span>Margin</span>
                      <strong className={`tnum ${s.margin !== null && s.margin < 0.6 ? "adm-bad" : "adm-good"}`}>
                        {s.margin === null ? "None" : `${Math.round(s.margin * 100)}%`}
                      </strong>
                    </div>
                  </div>
                  <div className="adm-meters">
                    {s.allowances.map((a) => (
                      <Meter key={a.unit} label={a.label} used={a.used} of={a.allowance} />
                    ))}
                  </div>
                  <p className="adm-foot">
                    {plural(s.channels, "call at once", "calls at once")} · {plural(s.numbers, "calling number")} · {plural(s.questions, "Jimmy question")} a month · agents:{" "}
                    {s.agents.map((a) => a.charAt(0) + a.slice(1).toLowerCase().replace("_", "-")).join(", ")}
                  </p>
                </div>
              ))}
            </section>
          ) : (
            <section className="card">
              <Empty>No plan is sold to this client. Its use is metered and nothing is refused on account of billing.</Empty>
            </section>
          )}

          <section className="adm-two">
            <div className="card">
              <CardHead title="Usage this month" sub={`Plans this month come to ${rs(monthCost)}`} />
              <UsageTable usage={d.usage} />
            </div>
            <div className="card">
              <CardHead title="Our cost by month" />
              <div className="adm-months">
                {d.trend.map((t, i) => (
                  <div key={t.period} className={`adm-month${i === d.trend.length - 1 ? " is-now" : ""}`}>
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

          <section className="card">
            <CardHead title="Payments" sub="Test payments are marked" />
            <div className="ws-scroll">
              <table className="ws-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">For</th>
                    <th scope="col">State</th>
                    <th scope="col" className="ws-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.payments.map((p, i) => (
                    <tr key={i}>
                      <td>{day(p.at)}</td>
                      <td>
                        {p.purpose === "PLAN" ? `${PLAN_WORDS[p.plan ?? ""] ?? "A"} plan` : p.purpose === "TOPUP" ? "Top-up" : p.purpose === "RENEWAL" ? "Monthly renewal" : words({}, p.purpose)}{" "}
                        {p.test && <span className="pill pill--quiet">Test</span>}
                      </td>
                      <td>
                        <span className={`pill ${p.status === "PAID" ? "pill--ok" : p.status === "FAILED" ? "pill--risk" : "pill--quiet"}`}>
                          {p.status === "PAID" ? "Paid" : p.status === "CREATED" ? "Not completed" : words({}, p.status)}
                        </span>
                      </td>
                      <td className="ws-num tnum">{rs(p.totalPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!d.payments.length && <Empty>No payments.</Empty>}
            </div>
          </section>
        </>
      )}

      {tab === "sales" && (
        <>
          <section className="adm-three">
            <div className="card">
              <CardHead title="Where leads came from" sub="All time" />
              <Donut parts={d.channels.map((x) => ({ label: words(CHANNEL_WORDS, x.channel), n: x.n }))} centre={num(c.leadsAll)} caption="leads" />
            </div>
            <div className="card">
              <CardHead title="Leads by stage" sub="Where every lead stands now" />
              <ul className="adm-stages">
                {STAGES.map((s) => (
                  <li key={s}>
                    <span>{STAGE_WORDS[s]}</span>
                    <CellBar value={stageN[s] ?? 0} max={Math.max(1, ...d.stages.map((x) => x.n))} label={num(stageN[s] ?? 0)} tone={s === "booked" ? "green" : s === "lost" ? "grey" : "blue"} />
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <CardHead title="How this month's calls ended" />
              <Donut parts={d.outcomes.slice(0, 5).map((x) => ({ label: words(OUTCOME_WORDS, x.outcome), n: x.n }))} centre={num(c.callsMonth)} caption="calls" />
            </div>
          </section>
          <section className="adm-two adm-two--even">
            <div className="card">
              <CardHead title="Leads a day" sub={`${num(leads30)} in 30 days`} />
              <Columns days={d.daily.leads} a="leads" b="booked" />
              <ColumnsKey a="Leads" b="Booked" />
            </div>
            <div className="card">
              <CardHead title="AI calls a day" sub={`${pct(picked30, calls30)} picked up`} />
              <Columns days={d.daily.calls} a="calls" b="picked up" />
              <ColumnsKey a="Placed" b="Picked up" />
            </div>
          </section>
          <section className="card">
            <CardHead title="Projects" />
            <ProjectsTable d={d} />
          </section>
        </>
      )}

      {tab === "content" && (
        <section className="adm-two adm-two--even">
          <div className="card">
            <CardHead title="What was made" sub="Every post, carousel and video kept, and those that did not pass the checks" />
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col" className="ws-num">Passed</th>
                  <th scope="col" className="ws-num">Did not pass</th>
                  <th scope="col" className="ws-num">Pass rate</th>
                </tr>
              </thead>
              <tbody>
                {d.content.map((x) => (
                  <tr key={x.kind}>
                    <td>{words(POST_KIND_WORDS, x.kind)}</td>
                    <td className="ws-num tnum">{num(x.passed)}</td>
                    <td className="ws-num tnum">{num(x.failed)}</td>
                    <td className="ws-num tnum">{pct(x.passed, x.passed + x.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d.content.length && <Empty>Nothing made yet.</Empty>}
          </div>
          <div className="card">
            <CardHead title="Where it went out" sub="Posts and ads on their accounts" />
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">Where</th>
                  <th scope="col">State</th>
                  <th scope="col" className="ws-num">How many</th>
                </tr>
              </thead>
              <tbody>
                {d.publications.map((x, i) => (
                  <tr key={i}>
                    <td>{words(DEST_WORDS, x.destination)}</td>
                    <td>
                      <span className={`pill ${x.state === "LIVE" || x.state === "ACTIVE" ? "pill--ok" : x.state === "FAILED" ? "pill--risk" : "pill--quiet"}`}>{words({}, x.state)}</span>
                    </td>
                    <td className="ws-num tnum">{num(x.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d.publications.length && <Empty>Nothing published yet.</Empty>}
          </div>
        </section>
      )}

      {tab === "people" && (
        <section className="adm-two">
          <div className="card">
            <CardHead title="People" sub={plural(d.people.length, "person", "people")} />
            <div className="ws-scroll">
              <table className="ws-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Where</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  {d.people.map((p, i) => (
                    <tr key={i}>
                      <td>
                        <span className="adm-who">
                          <span className="adm-avatar" aria-hidden>
                            {(p.name ?? p.email ?? "?").slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <strong>{p.name ?? "No name"}</strong>
                            <small>{p.email ?? (p.phone ? "Signs in with a phone" : "")}</small>
                          </span>
                        </span>
                      </td>
                      <td>{roleWords(p.role)}</td>
                      <td>{p.place}</td>
                      <td>{day(p.joined)}</td>
                      <td>{ago(p.lastLogin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <CardHead title="Connected accounts and numbers" />
            <ul className="adm-list">
              {d.connections.map((x) => (
                <li key={x.provider}>
                  <span className="adm-list__main">
                    <strong>{x.provider === "META" ? "Meta" : x.provider === "GOOGLE" ? "Google" : words({}, x.provider)}</strong>
                    <small>Checked {ago(x.checkedAt)}{x.error ? ` · ${x.error}` : ""}</small>
                  </span>
                  <span className={`pill ${x.status === "CONNECTED" ? "pill--ok" : "pill--risk"}`}>{x.status === "CONNECTED" ? "Connected" : words({}, x.status)}</span>
                </li>
              ))}
              {d.numbers.map((x) => (
                <li key={x.kind + x.label}>
                  <span className="adm-list__main">
                    <strong>{x.kind === "WhatsApp" ? "WhatsApp number" : "Calling number"}</strong>
                    <small>{x.label}</small>
                  </span>
                  <span className={`pill ${x.state === "GREEN" || x.state === "Active" ? "pill--ok" : x.state === "RED" ? "pill--risk" : "pill--quiet"}`}>{words({}, x.state)}</span>
                </li>
              ))}
            </ul>
            {!d.connections.length && !d.numbers.length && <Empty>Nothing connected yet.</Empty>}
          </div>
        </section>
      )}

      {tab === "activity" && (
        <section className="adm-two">
          <div className="card">
            <CardHead title="Latest activity" sub="From their audit trail, newest first" />
            <ul className="adm-feed">
              {d.activity.map((a, i) => (
                <li key={i}>
                  <span className="adm-feed__dot" aria-hidden>
                    <Board size={12} />
                  </span>
                  <span className="adm-list__main">
                    <strong>{a.words}</strong>
                    <small>
                      {a.who ?? "The system"} · {ago(a.at)}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
            {!d.activity.length && <Empty>Nothing yet.</Empty>}
          </div>
          <NoteCard id={id} tab={tab} isTest={c.isTest} note={c.note} saved={sp.saved === "1"} />
        </section>
      )}
    </>
  );
}

function ProjectsTable({ d }: { d: NonNullable<Awaited<ReturnType<typeof clientDetail>>> }) {
  const max = Math.max(1, ...d.projects.map((p) => p.costMonthPaise));
  if (!d.projects.length) return <Empty>No projects yet.</Empty>;
  return (
    <div className="ws-scroll">
      <table className="ws-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Plan</th>
            <th scope="col" className="ws-num">Towers</th>
            <th scope="col" className="ws-num">Leads this month</th>
            <th scope="col" className="ws-num">Leads in all</th>
            <th scope="col" className="ws-num">Call minutes</th>
            <th scope="col">Our cost</th>
          </tr>
        </thead>
        <tbody>
          {d.projects.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.name}</strong>
                <span className="ws-sub">{p.city ?? ""}</span>
              </td>
              <td>{p.plan ? <span className="pill pill--blue">{PLAN_WORDS[p.plan] ?? p.plan}</span> : <span className="adm-faint">No plan</span>}</td>
              <td className="ws-num tnum">{p.towers}</td>
              <td className="ws-num tnum">{num(p.leadsMonth)}</td>
              <td className="ws-num tnum">{num(p.leadsAll)}</td>
              <td className="ws-num tnum">{num(p.callMinutesMonth)}</td>
              <td>
                <CellBar value={p.costMonthPaise} max={max} label={rsShort(p.costMonthPaise)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageTable({ usage }: { usage: NonNullable<Awaited<ReturnType<typeof clientDetail>>>["usage"] }) {
  if (!usage.length) return <Empty>Nothing metered this month.</Empty>;
  return (
    <div className="ws-scroll">
      <table className="ws-table">
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col" className="ws-num">Made</th>
            <th scope="col" className="ws-num">Last month</th>
            <th scope="col" className="ws-num">Our cost</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((u) => (
            <tr key={u.kind}>
              <td>
                {KINDS[u.kind]?.label ?? u.kind}
                <span className="ws-sub">{KINDS[u.kind]?.vendor}</span>
              </td>
              <td className="ws-num tnum">{num(u.made)}</td>
              <td className="ws-num tnum">{num(u.lastMonthMade)}</td>
              <td className="ws-num tnum">{rs(u.costPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoteCard({ id, tab, isTest, note, saved }: { id: string; tab: string; isTest: boolean; note: string | null; saved: boolean }) {
  return (
    <form action={saveNoteAction} className="card adm-note">
      <CardHead title="Our note" sub="Only Sales Desk staff see this" action={saved ? <span className="pill pill--ok">Saved</span> : undefined} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="tab" value={tab} />
      <textarea name="note" defaultValue={note ?? ""} rows={5} maxLength={2000} placeholder="Pilot until 30 Nov. Rahul decides on the plan." />
      <label className="adm-check">
        <input type="checkbox" name="test" defaultChecked={isTest} />
        This is a test company. Leave it out of every total.
      </label>
      <button type="submit" className="btn btn--ink">
        Save note
      </button>
    </form>
  );
}
