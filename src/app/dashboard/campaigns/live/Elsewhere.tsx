import type { CampaignElsewhere } from "@/lib/ad-budget";
import { placeCampaignAction } from "@/app/actions/publish";
import { showRupees } from "@/lib/connect-rules";

/**
 * Campaigns somebody made in Ads Manager on a connected ad account. Their
 * money is real, so it is shown here and counted in Reports; a person says
 * which tower each one advertised, and its leads are filed there.
 */
export function Elsewhere({
  list,
  towers,
  back,
}: {
  list: CampaignElsewhere[];
  /** The towers this person may place spend on. Empty: read only. */
  towers: { id: string; label: string }[];
  back: string;
}) {
  if (!list.length) return null;
  const total = list.reduce((n, c) => n + c.spend, 0);
  return (
    <section className="card pub-else" aria-labelledby="pub-else-title" data-elsewhere>
      <div className="pub-else__head">
        <h2 id="pub-else-title">Made in Ads Manager</h2>
        <span className="pub-else__total tnum">{showRupees(total)} spent</span>
      </div>
      <ul className="pub-list">
        {list.map((c) => (
          <li key={`${c.accountId}-${c.campaignId}`} className="pub-else__row" data-campaign={c.campaignId}>
            <span className="pub-row__what">
              <strong>{c.name}</strong>
              <small>
                {c.accountName} · {shortDay(c.firstDay)}
                {c.lastDay !== c.firstDay ? ` to ${shortDay(c.lastDay)}` : ""}
              </small>
            </span>
            <span className="pub-else__num tnum">
              <strong>{showRupees(c.spend)}</strong>
              <small>
                {c.leads} {c.leads === 1 ? "lead" : "leads"} here
                {c.platformLeads !== c.leads ? ` · Meta counts ${c.platformLeads}` : ""}
              </small>
            </span>
            {c.phaseId && !towers.length ? (
              <span className="pub-else__place">{c.phaseName}</span>
            ) : towers.length ? (
              <form action={placeCampaignAction} className="pub-else__form">
                <input type="hidden" name="accountId" value={c.accountId} />
                <input type="hidden" name="campaignId" value={c.campaignId} />
                <input type="hidden" name="back" value={back} />
                <select
                  name="phaseId"
                  className="select-field"
                  defaultValue={c.phaseId ?? ""}
                  aria-label={`Tower ${c.name} advertised`}
                  required
                >
                  <option value="" disabled>
                    Which tower?
                  </option>
                  {towers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button type="submit" className={`btn btn--sm ${c.phaseId ? "btn--ghost" : "btn--ink"}`}>
                  {c.phaseId ? "Move" : "Count it here"}
                </button>
              </form>
            ) : (
              <span className="pill pill--warn">Not placed yet</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
}
