import Link from "next/link";
import { showPhone } from "@/lib/call-rules";
import { ArrowUpRight, Chat } from "@/components/icons";
import "./whatsapp/whatsapp.css";

/**
 * The developer's own WhatsApp number, as one card on Connected accounts:
 * whether it sends, which number writes where, and the one thing to do
 * next. It shares the CRM's row, below Meta and Google, and is that row's
 * dark card only when the CRM is not already.
 */
export function WhatsAppCard({
  summary,
  quiet = false,
}: {
  summary: { accounts: number; numbers: { display: string; place: string | null }[]; needs: string | null; broken: boolean };
  /** Another card in the row is already the dark one; say it in the pill only. */
  quiet?: boolean;
}) {
  const connected = summary.accounts > 0;
  const needs = connected && !!summary.needs;
  const dark = needs && !quiet;
  const pill = !connected
    ? { tone: "quiet", text: "Not connected" }
    : summary.broken
      ? { tone: "risk", text: "Stopped working" }
      : needs
        ? { tone: "warn", text: "Needs you" }
        : { tone: "ok", text: "Sending" };

  return (
    <section className={`conn wa-conn${dark ? " conn--needs" : ""}`} data-provider="whatsapp">
      <header className="conn__head">
        <span className="conn__mark" aria-hidden="true">
          <Chat size={18} />
        </span>
        <div className="conn__id">
          <h2>
            {connected ? (
              <Link href="/dashboard/settings/connections/whatsapp" className="conn__title">
                WhatsApp
              </Link>
            ) : (
              "WhatsApp"
            )}
          </h2>
          <p>{connected ? "Buyers hear from your own number." : "Your own number, for every message to a buyer."}</p>
        </div>
        <span className={`pill pill--${pill.tone}`}>
          <span className="pill__dot" />
          {pill.text}
        </span>
      </header>

      {needs && summary.needs && (
        <p className="conn__error" role="alert">
          {summary.needs}
        </p>
      )}

      {summary.numbers.length ? (
        <ul className="conn__rows">
          {summary.numbers.map((n) => (
            <li key={n.display} className="conn__row">
              <span className="conn__kind">Number</span>
              <strong className="conn__name tnum">{showPhone(n.display)}</strong>
              <span className="conn__where">{n.place ?? "Not used yet"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="conn__none">Not connected.</p>
      )}

      <footer className="conn__foot">
        <span className="conn__who" />
        {connected ? (
          <Link
            href="/dashboard/settings/connections/whatsapp"
            className={dark ? "btn btn--light btn--sm" : needs ? "btn btn--ink btn--sm" : "conn__open"}
            data-open="whatsapp"
          >
            Open
            {needs && <ArrowUpRight size={13} />}
          </Link>
        ) : (
          <Link href="/dashboard/settings/connections/whatsapp" className="btn btn--ink btn--sm" data-connect="whatsapp">
            Connect WhatsApp
            <ArrowUpRight size={13} />
          </Link>
        )}
      </footer>
    </section>
  );
}
