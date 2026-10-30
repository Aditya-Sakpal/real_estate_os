import Link from "next/link";
import { ArrowUpRight, Chat } from "@/components/icons";

/**
 * Service SMS as one card on Connected accounts: whether the developer's
 * DLT registration is recorded, and how many messages have their ids.
 */
export function SmsCard({ summary }: { summary: { header: string | null; registered: number; total: number; switchedOn: boolean } }) {
  const recorded = !!summary.header;
  const pill = !recorded
    ? { tone: "quiet", text: "Not set up" }
    : summary.registered < summary.total
      ? { tone: "warn", text: `${summary.registered} of ${summary.total} registered` }
      : { tone: "ok", text: summary.switchedOn ? "Ready" : "Registered" };
  return (
    <section className="conn" data-provider="sms">
      <header className="conn__head">
        <span className="conn__mark" aria-hidden="true">
          <Chat size={18} />
        </span>
        <div className="conn__id">
          <h2>
            <Link href="/dashboard/settings/connections/sms" className="conn__title">
              Service SMS
            </Link>
          </h2>
          <p>For buyers WhatsApp cannot reach.</p>
        </div>
        <span className={`pill pill--${pill.tone}`}>
          <span className="pill__dot" />
          {pill.text}
        </span>
      </header>
      {recorded ? (
        <ul className="conn__rows">
          <li className="conn__row">
            <span className="conn__kind">Header</span>
            <strong className="conn__name">{summary.header}</strong>
            <span className="conn__where">Your DLT registration</span>
          </li>
        </ul>
      ) : (
        <p className="conn__none">No DLT registration recorded.</p>
      )}
      <footer className="conn__foot">
        <span className="conn__who" />
        <Link href="/dashboard/settings/connections/sms" className={recorded ? "conn__open" : "btn btn--ink btn--sm"} data-open="sms">
          {recorded ? "Open" : "Add DLT details"}
          {!recorded && <ArrowUpRight size={13} />}
        </Link>
      </footer>
    </section>
  );
}
