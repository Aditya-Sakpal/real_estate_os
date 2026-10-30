import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight, Check, Close } from "@/components/icons";
import { vendorsData } from "@/lib/admin-data";
import { num, plural, rsShort } from "../../fmt";
import { CardHead, Stat } from "../kit";

export default async function AdminVendors({ searchParams }: { searchParams: Promise<{ fresh?: string }> }) {
  const { fresh } = await searchParams;
  const vendors = await vendorsData(fresh === "1");
  const low = vendors.filter((v) => v.state === "low");
  const month = vendors.reduce((s, v) => s + v.meteredMonthPaise, 0);
  const week = vendors.reduce((s, v) => s + v.burn7dPaise, 0);
  const soonest = vendors.filter((v) => v.daysLeft !== null).sort((a, b) => a.daysLeft! - b.daysLeft!)[0];

  return (
    <>
      <PageHead
        title={
          <>
            Vendors and <span className="em">balances</span>
          </>
        }
        meta="Live balances where the vendor publishes one, beside what our own use cost us. Balances refresh every two minutes."
        action={
          <Link href="/vendors?fresh=1" className="btn btn--ink">
            Read balances again
          </Link>
        }
      />

      <section className="adm-stats adm-stats--4">
        <Stat label="Running low" value={num(low.length)} sub={low.length ? low.map((v) => v.name).join(", ") : "Nothing low"} />
        <Stat label="Runs out first" value={soonest ? soonest.name : "None"} sub={soonest ? (soonest.daysLeft === 0 ? "Within a day at last week's pace" : `In about ${plural(soonest.daysLeft!, "day")} at last week's pace`) : "No balance to measure"} />
        <Stat label="Our metered spend this month" value={rsShort(month)} sub="Across every vendor" />
        <Stat label="Last 7 days" value={rsShort(week)} sub={`About ${rsShort(week / 7)} a day`} />
      </section>

      <section className="adm-vendors">
        {vendors.map((v) => (
          <article key={v.name} className={`card adm-vendor adm-vendor--${v.state}`}>
            <div className="adm-vendor__head">
              <div>
                <h2>{v.name}</h2>
                <span className="ws-sub">{v.forWhat}</span>
              </div>
              <span className={`pill ${v.state === "ok" ? "pill--ok" : v.state === "low" ? "pill--risk" : "pill--quiet"}`}>
                {v.state === "ok" ? "Healthy" : v.state === "low" ? "Top up" : "Check by hand"}
              </span>
            </div>
            <div className="adm-vendor__bal tnum">{v.balance ?? <span className="adm-faint">No live balance</span>}</div>
            {v.detail && <p className="adm-vendor__detail">{v.detail}</p>}
            <dl className="adm-vendor__facts">
              <div>
                <dt>Metered this month</dt>
                <dd className="tnum">{v.meteredMonthPaise ? rsShort(v.meteredMonthPaise) : "None"}</dd>
              </div>
              <div>
                <dt>Last 7 days</dt>
                <dd className="tnum">{v.burn7dPaise ? rsShort(v.burn7dPaise) : "None"}</dd>
              </div>
              <div>
                <dt>Lasts</dt>
                <dd className="tnum">{v.daysLeft === null ? "Unknown" : v.daysLeft === 0 ? "Under a day" : plural(v.daysLeft, "day")}</dd>
              </div>
            </dl>
            {v.spentTotal && <p className="adm-faint adm-vendor__spent">{v.spentTotal}</p>}
            <div className="adm-vendor__foot">
              {v.name === "Vercel" ? (
                <span />
              ) : (
                <span className={`adm-key-set${v.keySet ? " is-on" : ""}`}>
                  {v.keySet ? <Check size={12} /> : <Close size={12} />} {v.keySet ? "Key set on this server" : "No key on this server"}
                </span>
              )}
              <a href={v.link} target="_blank" rel="noreferrer" className="btn btn--light btn--sm">
                {v.state === "low" ? "Top up" : "Open"} <ArrowUpRight size={13} />
              </a>
            </div>
          </article>
        ))}
      </section>

      <section className="card">
        <CardHead title="What pays for what" sub="Our cost of each thing a client does, from the price list" />
        <div className="ws-scroll">
          <table className="ws-table">
            <thead>
              <tr>
                <th scope="col">A client does</th>
                <th scope="col">We pay</th>
                <th scope="col" className="ws-num">Our cost (worst case)</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["An AI call minute", "Sarvam Rs 3.50, Vobiz Rs 0.45", "Rs 4.35 (Rs 4.94)"],
                ["A call put through to a person, a minute", "Vobiz, two legs", "Rs 0.90 (Rs 1)"],
                ["An image post", "OpenAI design and checks", "Rs 17 (Rs 35)"],
                ["A carousel of 5 slides", "OpenAI design and checks", "Rs 72 (Rs 149)"],
                ["A video or film", "OpenRouter (Seedance), ElevenLabs", "Rs 720 to 1,420 (Rs 2,120)"],
                ["An Ask Jimmy question", "OpenAI", "Rs 0.50 (Rs 2.09)"],
                ["A WhatsApp broadcast, a person", "Meta, from the client's own card", "Rs 0.87"],
                ["A calling number, a month", "Vobiz", "Rs 600"],
              ].map(([what, who, cost]) => (
                <tr key={what}>
                  <td>{what}</td>
                  <td className="adm-faint">{who}</td>
                  <td className="ws-num tnum">{cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
