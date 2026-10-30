import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { Download, Search } from "@/components/icons";
import { listClients, type ClientRow } from "@/lib/admin-data";
import { ago, KIND_WORDS, num, pct, PLAN_WORDS, rsShort } from "../../fmt";
import { CellBar } from "../kit";

const SORTS: Record<string, { label: string; by: (a: ClientRow, b: ClientRow) => number }> = {
  activity: { label: "Last active", by: (a, b) => (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0) },
  cost: { label: "Our cost", by: (a, b) => b.costMonthPaise - a.costMonthPaise },
  value: { label: "Plan value", by: (a, b) => b.planValuePaise - a.planValuePaise },
  leads: { label: "Leads", by: (a, b) => b.leadsMonth - a.leadsMonth },
  calls: { label: "AI calls", by: (a, b) => b.callsMonth - a.callsMonth },
  newest: { label: "Newest", by: (a, b) => b.createdAt.getTime() - a.createdAt.getTime() },
  name: { label: "Name", by: (a, b) => a.name.localeCompare(b.name) },
};

const SHOW: Record<string, { label: string; keep: (c: ClientRow) => boolean }> = {
  all: { label: "All", keep: () => true },
  plan: { label: "On a plan", keep: (c) => c.plans.length > 0 },
  noplan: { label: "No plan", keep: (c) => c.plans.length === 0 },
  active: { label: "Active in 30 days", keep: (c) => !!c.lastActivity && Date.now() - c.lastActivity.getTime() < 30 * 86_400_000 },
  quiet: { label: "Gone quiet", keep: (c) => !c.lastActivity || Date.now() - c.lastActivity.getTime() >= 30 * 86_400_000 },
};

const JOINED = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const joined = (d: Date) => JOINED.format(d);

function planGroups(plans: { plan: string }[]): { plan: string; n: number }[] {
  const m = new Map<string, number>();
  for (const p of plans) m.set(p.plan, (m.get(p.plan) ?? 0) + 1);
  return [...m.entries()].map(([plan, n]) => ({ plan, n }));
}

type Q = { q?: string; kind?: string; show?: string; sort?: string; tests?: string };

function href(q: Q, change: Partial<Q>): string {
  const next = { ...q, ...change };
  const s = new URLSearchParams(Object.entries(next).filter(([, v]) => v) as [string, string][]).toString();
  return `/clients${s ? `?${s}` : ""}`;
}

export default async function AdminClients({ searchParams }: { searchParams: Promise<Q> }) {
  const q = await searchParams;
  const sort = SORTS[q.sort ?? ""] ? q.sort! : "activity";
  const show = SHOW[q.show ?? ""] ? q.show! : "all";
  const all = await listClients();
  const real = all.filter((c) => q.tests === "1" || !c.isTest);
  const term = (q.q ?? "").trim().toLowerCase();
  const rows = real
    .filter((c) => !q.kind || c.type === q.kind)
    .filter(SHOW[show].keep)
    .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.legalName ?? "").toLowerCase().includes(term))
    .sort(SORTS[sort].by);
  const maxCost = Math.max(1, ...rows.map((c) => c.costMonthPaise));
  const tests = all.filter((c) => c.isTest).length;

  return (
    <>
      <PageHead
        title={
          <>
            Every <span className="em">client</span>
          </>
        }
        meta={`${num(rows.length)} shown of ${num(real.length)}${tests ? ` · ${tests} marked as tests ${q.tests === "1" ? "shown" : "hidden"}` : ""}`}
        action={
          <a href={`/export/clients${q.tests === "1" ? "?tests=1" : ""}`} className="btn btn--ink">
            <Download size={14} /> Download CSV
          </a>
        }
      />

      <section className="card adm-list-card">
        <div className="adm-filters">
          <form action="/clients" className="adm-search">
            <Search size={14} />
            <input name="q" defaultValue={q.q ?? ""} placeholder="Find a client by name" aria-label="Find a client" />
            {q.kind && <input type="hidden" name="kind" value={q.kind} />}
            {q.show && <input type="hidden" name="show" value={q.show} />}
            {q.sort && <input type="hidden" name="sort" value={q.sort} />}
            {q.tests && <input type="hidden" name="tests" value={q.tests} />}
          </form>
          <nav className="adm-chips" aria-label="Kind">
            <Link href={href(q, { kind: undefined })} className={`pill ${!q.kind ? "pill--blue" : "pill--quiet"}`}>
              Every kind
            </Link>
            {Object.entries(KIND_WORDS).map(([k, w]) => (
              <Link key={k} href={href(q, { kind: k })} className={`pill ${q.kind === k ? "pill--blue" : "pill--quiet"}`}>
                {w}
              </Link>
            ))}
          </nav>
          <nav className="adm-chips" aria-label="Show">
            {Object.entries(SHOW).map(([k, s]) => (
              <Link key={k} href={href(q, { show: k === "all" ? undefined : k })} className={`pill ${show === k ? "pill--blue" : "pill--quiet"}`}>
                {s.label}
              </Link>
            ))}
            {tests > 0 && (
              <Link href={href(q, { tests: q.tests === "1" ? undefined : "1" })} className={`pill ${q.tests === "1" ? "pill--warn" : "pill--quiet"}`}>
                {q.tests === "1" ? "Hide tests" : "Show tests"}
              </Link>
            )}
          </nav>
          <div className="adm-sort">
            <span>Sort</span>
            <nav className="adm-chips">
              {Object.entries(SORTS).map(([k, s]) => (
                <Link key={k} href={href(q, { sort: k === "activity" ? undefined : k })} className={`adm-sortlink${sort === k ? " is-on" : ""}`}>
                  {s.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>

        <div className="ws-scroll">
          <table className="ws-table adm-table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Plan</th>
                <th scope="col" className="ws-num">Projects</th>
                <th scope="col" className="ws-num">People</th>
                <th scope="col">Last active</th>
                <th scope="col" className="ws-num">Leads</th>
                <th scope="col" className="ws-num">AI calls</th>
                <th scope="col" className="ws-num">Picked up</th>
                <th scope="col" className="ws-num">Minutes</th>
                <th scope="col" className="ws-num">Posts</th>
                <th scope="col" className="ws-num">Videos</th>
                <th scope="col">Our cost this month</th>
                <th scope="col" className="ws-num">Plan value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/clients/${c.id}`} className="adm-who">
                      <span className={`adm-avatar adm-avatar--${c.type.toLowerCase()}`} aria-hidden>
                        {c.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{c.name}</strong>
                        <small>
                          {KIND_WORDS[c.type] ?? c.type} · joined {joined(c.createdAt)}
                          {c.status !== "ACTIVE" ? " · not claimed" : ""}
                          {c.isTest ? " · test" : ""}
                          {c.note ? " · has a note" : ""}
                        </small>
                      </span>
                    </Link>
                  </td>
                  <td>
                    {c.plans.length ? (
                      <span className="adm-pills">
                        {planGroups(c.plans).map((g) => (
                          <span key={g.plan} className="pill pill--blue">
                            {g.n > 1 ? `${g.n} × ` : ""}
                            {PLAN_WORDS[g.plan] ?? g.plan}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="adm-faint">No plan</span>
                    )}
                  </td>
                  <td className="ws-num tnum">{c.projects}</td>
                  <td className="ws-num tnum">{c.members}</td>
                  <td>
                    <span className={`adm-fresh${c.lastActivity && Date.now() - c.lastActivity.getTime() < 7 * 86_400_000 ? " is-on" : ""}`} />
                    {ago(c.lastActivity)}
                  </td>
                  <td className="ws-num tnum">{num(c.leadsMonth)}</td>
                  <td className="ws-num tnum">{num(c.callsMonth)}</td>
                  <td className="ws-num tnum">{c.callsMonth ? pct(c.connectedMonth, c.callsMonth) : "-"}</td>
                  <td className="ws-num tnum">{num(c.callMinutesMonth)}</td>
                  <td className="ws-num tnum">{num(c.postsMonth)}</td>
                  <td className="ws-num tnum">{num(c.videosMonth)}</td>
                  <td>
                    {c.costMonthPaise > 0 ? <CellBar value={c.costMonthPaise} max={maxCost} label={rsShort(c.costMonthPaise)} /> : <span className="adm-faint">None</span>}
                  </td>
                  <td className="ws-num tnum">{c.planValuePaise ? rsShort(c.planValuePaise) : <span className="adm-faint">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="adm-faint adm-empty">No client matches.</p>}
        </div>
        <p className="adm-foot">Leads, calls, posts, videos and cost are this month&apos;s, in India time.</p>
      </section>
    </>
  );
}
