import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { callsData } from "@/lib/admin-data";
import { AGENT_WORDS, ago, num, OUTCOME_WORDS, pct, words } from "../../fmt";
import { CardHead, CellBar, Columns, ColumnsKey, Delta, Donut, Empty, Stat } from "../kit";

const TEMP_WORDS: Record<string, string> = { HOT: "Hot", WARM: "Warm", COLD: "Cold", NOT_READ: "Not read yet" };

export default async function AdminCalls() {
  const c = await callsData();
  const m = c.month;
  const maxAgent = Math.max(1, ...c.agents.map((a) => a.placed));

  return (
    <>
      <PageHead
        title={
          <>
            AI <span className="em">calls</span>
          </>
        }
        meta="Every AI call across every client this month, in India time. Test companies are left out."
      />

      <section className="adm-stats adm-stats--4">
        <Stat label="Calls placed" value={num(m.placed)} delta={<Delta now={m.placed} before={c.lastMonth.placed} />} sub={`${num(m.inbound)} answered on a client's number`} />
        <Stat label="Picked up" value={pct(m.connected, m.placed)} sub={`${num(m.connected)} calls · ${pct(c.lastMonth.connected, c.lastMonth.placed)} last month`} />
        <Stat label="Call minutes" value={num(m.minutes)} delta={<Delta now={m.minutes} before={c.lastMonth.minutes} upIsGood={false} />} sub={`${Math.floor(m.avgConnectedS / 60)} min ${m.avgConnectedS % 60} s a picked-up call`} />
        <Stat label="Put through to a person" value={num(m.handedOff)} sub={`${num(m.refused)} refused before dialling · ${num(m.systemFailure)} failed on our side`} />
      </section>

      <section className="adm-two">
        <div className="card">
          <CardHead title="Calls a day" sub="Last 30 days" />
          <Columns days={c.daily} a="calls" b="picked up" />
          <ColumnsKey a="Placed" b="Picked up" />
        </div>
        <div className="card">
          <CardHead title="How calls ended" sub="This month" />
          <Donut parts={c.outcomes.slice(0, 6).map((o) => ({ label: words(OUTCOME_WORDS, o.outcome), n: o.n }))} centre={num(m.placed)} caption="calls" />
        </div>
      </section>

      <section className="adm-two adm-two--even">
        <div className="card">
          <CardHead title="By agent" sub="This month" />
          <table className="ws-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Placed</th>
                <th scope="col" className="ws-num">Picked up</th>
                <th scope="col" className="ws-num">Minutes</th>
              </tr>
            </thead>
            <tbody>
              {c.agents.map((a) => (
                <tr key={a.agent}>
                  <td>{words(AGENT_WORDS, a.agent)}</td>
                  <td>
                    <CellBar value={a.placed} max={maxAgent} label={num(a.placed)} />
                  </td>
                  <td className="ws-num tnum">{pct(a.connected, a.placed)}</td>
                  <td className="ws-num tnum">{num(a.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!c.agents.length && <Empty>No calls this month.</Empty>}
        </div>
        <div className="card">
          <CardHead title="How warm the buyers were" sub="Picked-up calls this month, by our score" />
          <Donut parts={c.temperature.map((t) => ({ label: words(TEMP_WORDS, t.t), n: t.n }))} centre={num(m.connected)} caption="picked up" />
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
                  <th scope="col" className="ws-num">Placed</th>
                  <th scope="col" className="ws-num">Picked up</th>
                  <th scope="col" className="ws-num">Minutes</th>
                  <th scope="col" className="ws-num">Hot or warm</th>
                </tr>
              </thead>
              <tbody>
                {c.byClient.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link href={`/clients/${x.id}?tab=sales`} className="adm-strong">
                        {x.name}
                      </Link>
                    </td>
                    <td className="ws-num tnum">{num(x.placed)}</td>
                    <td className="ws-num tnum">{pct(x.connected, x.placed)}</td>
                    <td className="ws-num tnum">{num(x.minutes)}</td>
                    <td className="ws-num tnum">{num(x.hot)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!c.byClient.length && <Empty>No calls this month.</Empty>}
          </div>
        </div>
        <div className="card">
          <CardHead title="Calls that failed or were refused" sub="Last 30 days" />
          <ul className="adm-list">
            {c.failures.map((f, i) => (
              <li key={i}>
                <span className="adm-list__main">
                  <strong>{words(OUTCOME_WORDS, f.reason)}</strong>
                  <small>Last {ago(f.last)}</small>
                </span>
                <span className="pill pill--risk tnum">{num(f.n)}</span>
              </li>
            ))}
          </ul>
          {!c.failures.length && <Empty>None.</Empty>}
        </div>
      </section>
    </>
  );
}
