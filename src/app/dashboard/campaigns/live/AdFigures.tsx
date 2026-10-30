import type { AdFigures as Figures } from "@/lib/ad-budget";
import { showRupees } from "@/lib/connect-rules";
import type { PublicationView } from "@/lib/publish";
import "./figures.css";

/**
 * What one ad spent and brought, and the last time its budget moved. One
 * dense line under the ad's row: the numbers a sales head asks about first.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Sep", on the IST calendar. */
function dayMonth(iso: string): string {
  const [, m, d] = new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** Whether an ad has anything worth a line: it ran, or it brought or moved something. */
export function hasFigures(p: PublicationView, f: Figures | undefined): f is Figures {
  if (!p.ad || !f) return false;
  return p.state === "ACTIVE" || p.state === "PAUSED" || f.spend > 0 || f.leads > 0 || f.shifts.length > 0;
}

export function AdFigures({ id, figures }: { id: string; figures: Figures }) {
  const last = figures.shifts[0];
  return (
    <div className="pub-figs" data-ad-figures={id}>
      <span className="pub-fig">
        <strong className="tnum">{figures.spend > 0 ? showRupees(figures.spend) : "None"}</strong> spent in 30 days
      </span>
      <span className="pub-fig">
        <strong className="tnum">{plural(figures.leads, "lead", "leads")}</strong>
      </span>
      {figures.costPerLead !== null && (
        <span className="pub-fig">
          <strong className="tnum">{showRupees(figures.costPerLead)}</strong> a lead
        </span>
      )}
      <span className="pub-fig">
        <strong className="tnum">{figures.qualified.toLocaleString("en-IN")}</strong> qualified
      </span>
      <span className="pub-fig">
        <strong className="tnum">{plural(figures.bookings, "booking", "bookings")}</strong>
      </span>
      {last &&
        (last.state === "APPLIED" ? (
          <span className={`pub-shift pub-shift--${last.rule === "SCALE_UP" ? "up" : "down"} tnum`} data-budget-move>
            Budget {showRupees(last.from)} to {showRupees(last.to)} a day, {dayMonth(last.at)}
          </span>
        ) : (
          <span className="pub-shift pub-shift--failed tnum" data-budget-move>
            Budget move to {showRupees(last.to)} a day did not go through, {dayMonth(last.at)}
          </span>
        ))}
      {figures.health.pause && (
        <span className="pub-flag pub-flag--risk" data-ad-health="pause">
          Costs twice the others or more per result. Pause it?
        </span>
      )}
      {figures.health.refresh && (
        <span className={`pub-flag pub-flag--${figures.health.refresh === "DUE" ? "due" : "watch"} tnum`} data-ad-health="refresh">
          {refreshWords(figures.health)}
        </span>
      )}
    </div>
  );
}

/** Why a creative looks tired, in the numbers a marketer checks. */
function refreshWords(h: Figures["health"]): string {
  const seen = h.frequency !== null ? `Seen ${h.frequency.toFixed(1)} times per person` : null;
  const fell = h.ctrDrop !== null && h.ctrDrop >= 0.2 ? `clicks down ${Math.round(h.ctrDrop * 100)}% since its first week` : null;
  const why = [seen, fell].filter(Boolean).join(", ");
  return h.refresh === "DUE" ? `${why}. Time for a new creative.` : `${why}. Tiring.`;
}
