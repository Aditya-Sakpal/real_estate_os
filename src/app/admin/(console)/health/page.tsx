import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { healthData } from "@/lib/admin-data";
import { ago, num, words } from "../../fmt";
import { CardHead, Empty, Stat } from "../kit";

export default async function AdminHealth() {
  const h = await healthData();
  const k = h.counts;
  const areas = [...new Set(h.groups.map((g) => g.area))];

  return (
    <>
      <PageHead
        title={
          <>
            System <span className="em">health</span>
          </>
        }
        meta="What failed, what is waiting, and every connection and number, across all clients (test companies included)."
      />

      <section className="adm-stats adm-stats--4">
        <Stat label="Calls failed on our side" value={num(k.callsSystemFailure7d)} sub={`${num(k.callsRefused7d)} refused before dialling · 7 days`} />
        <Stat label="WhatsApp messages failed" value={num(k.messagesFailed7d)} sub="Last 7 days" />
        <Stat label="Videos failed" value={num(k.reelFailed7d)} sub={`${num(k.publishFailed)} posts or ads failed to publish`} />
        <Stat label="Engine tasks failed" value={num(k.tasksFailed7d)} sub={`${num(k.crmDead)} CRM writes given up`} />
      </section>

      <section className="adm-two">
        <div className="card">
          <CardHead title="Waiting in the queues" sub="Work the worker has not done yet" />
          <ul className="adm-list">
            {h.queues.map((q) => (
              <li key={q.name}>
                <span className="adm-list__main">
                  <strong>{q.name}</strong>
                  <small>{q.oldest ? `Oldest from ${ago(q.oldest)}` : "Nothing waiting"}</small>
                </span>
                <span className={`pill ${q.due ? "pill--warn" : "pill--ok"} tnum`}>{num(q.due)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <CardHead title="Why things failed" sub="Grouped by reason" />
          {areas.length ? (
            areas.map((a) => (
              <div key={a} className="adm-group">
                <h3>{a}</h3>
                <ul className="adm-list">
                  {h.groups
                    .filter((g) => g.area === a)
                    .map((g, i) => (
                      <li key={i}>
                        <span className="adm-list__main">
                          <strong>{g.what.replace(/_/g, " ")}</strong>
                          <small>Last {ago(g.last)}</small>
                        </span>
                        <span className="pill pill--risk tnum">{num(g.n)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))
          ) : (
            <Empty>Nothing failed recently.</Empty>
          )}
        </div>
      </section>

      <section className="adm-two adm-two--even">
        <div className="card">
          <CardHead title="Meta and Google connections" />
          <div className="ws-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Account</th>
                  <th scope="col">State</th>
                  <th scope="col">Checked</th>
                </tr>
              </thead>
              <tbody>
                {h.connections.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <Link href={`/clients/${c.orgId}?tab=people`} className="adm-strong">
                        {c.orgName}
                      </Link>
                    </td>
                    <td>{c.provider === "META" ? "Meta" : c.provider === "GOOGLE" ? "Google" : words({}, c.provider)}</td>
                    <td>
                      <span className={`pill ${c.status === "CONNECTED" ? "pill--ok" : "pill--risk"}`}>{words({}, c.status)}</span>
                      {c.error && <span className="ws-sub">{c.error}</span>}
                    </td>
                    <td>{ago(c.checkedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!h.connections.length && <Empty>No client has connected Meta or Google.</Empty>}
          </div>
        </div>
        <div className="card">
          <CardHead title="WhatsApp and calling numbers" />
          <div className="ws-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Number</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {h.numbers.map((n, i) => (
                  <tr key={i}>
                    <td>
                      <Link href={`/clients/${n.orgId}?tab=people`} className="adm-strong">
                        {n.orgName}
                      </Link>
                    </td>
                    <td>
                      {n.kind}
                      <span className="ws-sub">{n.label}</span>
                    </td>
                    <td>
                      <span className={`pill ${n.state === "GREEN" || n.state === "Active" ? "pill--ok" : n.state === "RED" ? "pill--risk" : "pill--quiet"}`}>{words({}, n.state)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!h.numbers.length && <Empty>No numbers yet.</Empty>}
          </div>
        </div>
      </section>
    </>
  );
}
