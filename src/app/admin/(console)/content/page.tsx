import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { contentData } from "@/lib/admin-data";
import { ago, DEST_WORDS, num, pct, POST_KIND_WORDS, words } from "../../fmt";
import { CardHead, Donut, Empty, Stat } from "../kit";

const FORMAT_WORDS: Record<string, string> = { presenter: "Films (every template)", story: "Narrated story", reel: "Story reel" };
const RUN_WORDS: Record<string, string> = {
  GENERATED: "Made, waiting for review",
  RELEASED: "Approved and sent",
  EXPIRED: "Expired unreviewed",
  REFUSED: "Refused before making",
  FAILED: "Failed",
  PENDING: "Waiting for its time",
};

function failureWhat(what: string): string {
  const film = /^Video \((\w+)\)$/.exec(what);
  if (film) return words(FORMAT_WORDS, film[1]).replace(" (every template)", "");
  const pub = /^Publish to (\w+)$/.exec(what);
  if (pub) return `Publishing to ${words(DEST_WORDS, pub[1])}`;
  return what;
}

export default async function AdminContent() {
  const c = await contentData();
  const passed = c.posts.reduce((s, p) => s + p.passed, 0);
  const failed = c.posts.reduce((s, p) => s + p.failed, 0);
  const month = c.posts.reduce((s, p) => s + p.month, 0);
  const jobsDone = c.jobs.filter((j) => j.state === "DONE").reduce((s, j) => s + j.n, 0);
  const jobsFailed = c.jobs.filter((j) => j.state === "FAILED").reduce((s, j) => s + j.n, 0);
  const live = c.publications.filter((p) => p.state === "LIVE" || p.state === "ACTIVE").reduce((s, p) => s + p.n, 0);
  const dests = new Map<string, number>();
  for (const p of c.publications) dests.set(p.destination, (dests.get(p.destination) ?? 0) + p.n);

  return (
    <>
      <PageHead
        title={
          <>
            Posts and <span className="em">videos</span>
          </>
        }
        meta="What every client made and published. Test companies are left out."
      />

      <section className="adm-stats adm-stats--4">
        <Stat label="Made this month" value={num(month)} sub={`${num(passed + failed)} in all`} />
        <Stat label="Passed the checks" value={pct(passed, passed + failed)} sub={`${num(failed)} did not pass`} />
        <Stat label="Films delivered" value={num(jobsDone)} sub={`${num(jobsFailed)} failed`} />
        <Stat label="Live on their accounts" value={num(live)} sub="Posts and ads" />
      </section>

      <section className="adm-three">
        <div className="card">
          <CardHead title="By kind" />
          <Donut parts={c.posts.map((p) => ({ label: words(POST_KIND_WORDS, p.kind), n: p.all }))} centre={num(passed + failed)} caption="made" />
        </div>
        <div className="card">
          <CardHead title="Where they went out" />
          <Donut parts={[...dests.entries()].map(([k, n]) => ({ label: words(DEST_WORDS, k), n }))} centre={num([...dests.values()].reduce((s, v) => s + v, 0))} caption="sent" />
        </div>
        <div className="card">
          <CardHead title="Scheduled runs" sub="Posts a schedule made by itself" />
          <ul className="adm-list">
            {c.runs.map((r) => (
              <li key={r.state}>
                <span className="adm-list__main">
                  <strong>{words(RUN_WORDS, r.state)}</strong>
                </span>
                <strong className="tnum">{num(r.n)}</strong>
              </li>
            ))}
          </ul>
          {!c.runs.length && <Empty>No schedule has run.</Empty>}
        </div>
      </section>

      <section className="adm-two">
        <div className="card">
          <CardHead title="By client" />
          <div className="ws-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col" className="ws-num">Images</th>
                  <th scope="col" className="ws-num">Carousels</th>
                  <th scope="col" className="ws-num">Videos</th>
                  <th scope="col" className="ws-num">Live now</th>
                </tr>
              </thead>
              <tbody>
                {c.byClient.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link href={`/clients/${x.id}?tab=content`} className="adm-strong">
                        {x.name}
                      </Link>
                    </td>
                    <td className="ws-num tnum">{num(x.images)}</td>
                    <td className="ws-num tnum">{num(x.carousels)}</td>
                    <td className="ws-num tnum">{num(x.videos)}</td>
                    <td className="ws-num tnum">{num(x.published)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!c.byClient.length && <Empty>Nothing made yet.</Empty>}
          </div>
        </div>
        <div className="card">
          <CardHead title="Films and publishing" />
          <table className="ws-table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">State</th>
                <th scope="col" className="ws-num">How many</th>
              </tr>
            </thead>
            <tbody>
              {c.jobs.map((j, i) => (
                <tr key={`j${i}`}>
                  <td>{words(FORMAT_WORDS, j.format)}</td>
                  <td>
                    <span className={`pill ${j.state === "DONE" ? "pill--ok" : j.state === "FAILED" ? "pill--risk" : "pill--quiet"}`}>{words({}, j.state)}</span>
                  </td>
                  <td className="ws-num tnum">{num(j.n)}</td>
                </tr>
              ))}
              {c.publications.map((p, i) => (
                <tr key={`p${i}`}>
                  <td>{words(DEST_WORDS, p.destination)}</td>
                  <td>
                    <span className={`pill ${p.state === "LIVE" || p.state === "ACTIVE" ? "pill--ok" : p.state === "FAILED" ? "pill--risk" : "pill--quiet"}`}>{words({}, p.state)}</span>
                  </td>
                  <td className="ws-num tnum">{num(p.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <CardHead title="Latest failures" sub="Videos that failed and posts that did not publish" />
        <ul className="adm-list">
          {c.recentFailures.map((f, i) => (
            <li key={i}>
              <span className="adm-list__main">
                <strong>
                  {f.orgName} · {failureWhat(f.what)}
                </strong>
                <small className="adm-clamp">{f.message ?? "No reason recorded"}</small>
              </span>
              <span className="adm-faint">{ago(f.at)}</span>
            </li>
          ))}
        </ul>
        {!c.recentFailures.length && <Empty>Nothing failed.</Empty>}
      </section>
    </>
  );
}
