import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { PageHead } from "@/components/shell/PageHead";
import { Shield } from "@/components/icons";
import { AUDIT_AREAS, readAuditFilter } from "@/lib/audit-rules";
import { loadAuditTrail } from "@/lib/audit-trail";
import "./audit.css";

/**
 * The audit trail: who did what, and when, newest first. Read only; the log
 * it reads cannot be changed by anybody. Held at the organisation, because a
 * row is about the whole company rather than one tower.
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.canAt("audit:read", viewer.state.rootPath)) redirect("/dashboard/settings");
  const f = readAuditFilter(await searchParams);
  const page = await loadAuditTrail({ orgId: viewer.state.org.id, ...f });
  const filtered = !!(f.who || f.area || f.from || f.to);
  const year = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 4);
  const when = (iso: string) => {
    const d = new Date(iso);
    const day = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    const y = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 4);
    const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).toLowerCase();
    return `${day}${y === year ? "" : ` ${y}`}, ${time}`;
  };
  const olderHref = () => {
    const q = new URLSearchParams();
    if (f.who) q.set("who", f.who);
    if (f.area) q.set("area", f.area);
    if (f.from) q.set("from", f.from);
    if (f.to) q.set("to", f.to);
    q.set("before", String(page.next));
    return `/dashboard/settings/audit?${q}`;
  };

  return (
    <>
      <PageHead
        back={{ label: "Settings", href: "/dashboard/settings" }}
        title={
          <>
            Audit <span className="em">trail</span>
          </>
        }
        meta={f.before ? "Older entries" : "Who did what, and when"}
      />

      <form className="card au-filters" method="get" action="/dashboard/settings/audit" role="search" aria-label="Filter the trail">
        <label className="au-field">
          <span className="mv-label">Who</span>
          <select name="who" className="cl-select" defaultValue={f.who ?? ""}>
            <option value="">Everyone</option>
            <option value="system">Sales Desk, on its own</option>
            {page.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="au-field">
          <span className="mv-label">Area</span>
          <select name="area" className="cl-select" defaultValue={f.area ?? ""}>
            <option value="">Everything</option>
            {AUDIT_AREAS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="au-field au-field--day">
          <span className="mv-label">From</span>
          <input type="date" name="from" className="mv-input" defaultValue={f.from ?? ""} />
        </label>
        <label className="au-field au-field--day">
          <span className="mv-label">To</span>
          <input type="date" name="to" className="mv-input" defaultValue={f.to ?? ""} />
        </label>
        <div className="au-acts">
          <button type="submit" className="btn btn--ink">
            Show
          </button>
          {filtered && (
            <Link href="/dashboard/settings/audit" className="btn btn--ghost">
              Clear
            </Link>
          )}
        </div>
      </form>

      {page.rows.length === 0 ? (
        <section className="card empty">
          <span className="empty__mark">
            <Shield size={18} />
          </span>
          <h2>{filtered ? "Nothing matches these filters" : "Nothing yet"}</h2>
        </section>
      ) : (
        <section className="card au-sheet">
          <div className="ws-scroll">
            {/* Lays itself out as rows on a phone (audit.css), so the shared stacking leaves it be. */}
            <table className="ws-table au-table" data-keep>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">On</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="tnum au-when">{when(r.at)}</td>
                    <td className={r.byPerson ? undefined : "au-system"}>{r.who}</td>
                    <td>
                      <span className="au-what">{r.text}</span>
                      <span className="ws-sub">{r.areaLabel}</span>
                    </td>
                    <td className="au-on">{r.on ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.next && (
            <div className="au-more">
              <Link href={olderHref()} className="btn btn--ghost btn--sm">
                Older
              </Link>
            </div>
          )}
        </section>
      )}
    </>
  );
}
