import Link from "next/link";
import { CopyField } from "./CopyField";
import "./calling.css";

export type TowerAddress = { id: string; label: string; url: string };

export type MetaLeadForms =
  | { connected: false }
  | {
      connected: true;
      /** The connection stopped working or its access ran out. */
      broken: boolean;
      pages: { id: string; name: string; leadForms: boolean | null }[];
    };

const LEAD_FORM_PILL: Record<"yes" | "no" | "unknown", { tone: string; text: string }> = {
  yes: { tone: "ok", text: "Arriving" },
  no: { tone: "risk", text: "Meta refused" },
  unknown: { tone: "quiet", text: "Not set up" },
};

/**
 * Where leads come in: one address per tower for a website form or a Google
 * Ads lead form, the key Google asks for, and which Facebook Pages send
 * their lead forms. Read-only; the only controls are Copy.
 */
export function LeadCapture({
  towers,
  googleKey,
  meta,
  canConnect,
}: {
  /** Null when this server has no public address to give out. */
  towers: TowerAddress[] | null;
  googleKey: string | null;
  meta: MetaLeadForms;
  /** May connect Meta or choose its Pages. */
  canConnect: boolean;
}) {
  return (
    <section className="card cs cset" aria-labelledby="capture-title" data-lead-capture>
      <div className="cset__head">
        <h2 id="capture-title">Lead capture</h2>
      </div>

      <div className="cap-group">
        <p className="cap-group__title">Form addresses</p>
        <p className="cap-group__sub">
          For your website form, or as the webhook URL of a Google Ads lead form. One per tower.
        </p>
        {towers === null ? (
          <p className="cap-none">Not available yet.</p>
        ) : towers.length === 0 ? (
          <p className="cap-none">No towers yet.</p>
        ) : (
          <ul className="cap-list">
            {towers.map((t) => (
              <li key={t.id} data-capture-tower={t.id}>
                <CopyField id={`cap-${t.id}`} label={t.label} value={t.url} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cap-group">
        <p className="cap-group__title">Google Ads lead forms</p>
        {googleKey ? (
          <ul className="cap-list">
            <li>
              <CopyField id="cap-google-key" label="Key" value={googleKey} />
            </li>
          </ul>
        ) : (
          <p className="cap-none">Not available yet.</p>
        )}
      </div>

      <div className="cap-group">
        <p className="cap-group__title">Meta lead forms</p>
        <MetaPages meta={meta} canConnect={canConnect} />
      </div>
    </section>
  );
}

function MetaPages({ meta, canConnect }: { meta: MetaLeadForms; canConnect: boolean }) {
  if (!meta.connected) {
    return (
      <p className="cap-none">
        Meta is not connected.
        {canConnect && <Link href="/dashboard/settings/connections">Connect Meta</Link>}
      </p>
    );
  }
  if (meta.broken) {
    return (
      <p className="cap-none">
        Meta stopped working. Lead forms do not arrive until it is reconnected.
        {canConnect && <Link href="/dashboard/settings/connections/meta">Reconnect</Link>}
      </p>
    );
  }
  if (meta.pages.length === 0) {
    return (
      <p className="cap-none">
        No Facebook Page chosen.
        {canConnect && <Link href="/dashboard/settings/connections/meta?edit=1">Choose a Page</Link>}
      </p>
    );
  }
  return (
    <ul className="cap-list">
      {meta.pages.map((p) => {
        const pill = LEAD_FORM_PILL[p.leadForms === true ? "yes" : p.leadForms === false ? "no" : "unknown"];
        return (
          <li key={p.id} className="cap-page" data-lead-forms={p.id}>
            <span className="cap-page__name">{p.name}</span>
            <span className={`pill pill--${pill.tone}`}>
              {p.leadForms === true && <span className="pill__dot" />}
              {pill.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
