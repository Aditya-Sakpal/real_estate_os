import Link from "next/link";
import { ArrowUpRight } from "@/components/icons";
import type { Learning } from "@/lib/learning";

const TONE = {
  do: { pill: "pill--ok", word: "Works" },
  avoid: { pill: "pill--warn", word: "Weaker" },
  market: { pill: "pill--blue", word: "Market" },
} as const;

/**
 * What has worked for this project, ours and the market's, in plain
 * sentences. The next creative is made from the same scores, so this is
 * what the studio and the schedule are leaning on, said out loud.
 */
export function WhatWorked({ learning }: { learning: Learning }) {
  const lines = learning.playbook;
  const where = learning.place === "ORG" ? "across your projects" : "for this project";
  return (
    <section className="card ww" style={{ marginTop: 16 }} aria-labelledby="ww-h">
      <div className="card__head">
        <h2 id="ww-h">
          What has <span className="em">worked</span>
        </h2>
        <Link href="/dashboard/library/market" className="btn btn--ghost btn--sm">
          Competitor ads
          <ArrowUpRight size={13} />
        </Link>
      </div>
      {lines.length === 0 ? (
        <p className="ww-none">Nothing to go on yet. This fills in as your ads bring qualified buyers and your team saves competitor ads.</p>
      ) : (
        <ul className="ww-list">
          {lines.map((l) => (
            <li key={`${l.tone}|${l.dim}|${l.value}`} className="ww-line">
              <span className={`pill ${TONE[l.tone].pill}`}>{TONE[l.tone].word}</span>
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
      {(learning.ownAds > 0 || learning.marketAds > 0) && (
        <p className="ww-foot tnum">
          From {learning.ownAds} of your {learning.ownAds === 1 ? "ad" : "ads"} and {learning.marketAds} competitor{" "}
          {learning.marketAds === 1 ? "ad" : "ads"} {where}. The market counts for {Math.round(learning.marketWeight * 100)}% here.
        </p>
      )}
    </section>
  );
}
