import { approveBroadcastAction, stopBroadcastAction } from "@/app/actions/broadcast";
import type { BroadcastView } from "@/lib/broadcast";
import { HALT_WORDS, STATUS_PILL, canApprove, canStop, isLive, showPaise } from "@/lib/broadcast-rules";
import { ConfirmAction } from "@/components/ConfirmAction";
import "./broadcasts.css";

/**
 * WhatsApp broadcasts on Published: each one with what became of it (sent,
 * delivered, read, replied, not sent) and the one control its state allows.
 * A broadcast waiting for approval offers Approve to the budget key, behind
 * a confirmation that names the people and the credit; one waiting or
 * sending offers Stop to anybody who may stop an ad.
 */

const STOP_KEYS = ["creative:approve", "campaign:publish", "campaign.budget:manage"];

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const n = (x: number) => x.toLocaleString("en-IN");

export function Broadcasts({
  list,
  back,
  can,
}: {
  list: BroadcastView[];
  back: string;
  can: (key: string, path: string) => boolean;
}) {
  if (!list.length) return null;
  const waiting = list.filter((b) => canApprove(b.status)).length;

  return (
    <section className="card pub-sheet bcl" aria-labelledby="bcl-title" data-broadcasts>
      <div className="bcl__head">
        <h2 id="bcl-title">WhatsApp broadcasts</h2>
        {waiting > 0 && <span className="pill pill--warn">{waiting} waiting for approval</span>}
      </div>
      <ul className="pub-list">
        {list.map((b) => (
          <Row key={b.id} b={b} back={back} can={can} />
        ))}
      </ul>
    </section>
  );
}

function Row({ b, back, can }: { b: BroadcastView; back: string; can: (key: string, path: string) => boolean }) {
  const pill = STATUS_PILL[b.status];
  const c = b.counts;
  const people = `${n(b.audience)} ${b.audience === 1 ? "person" : "people"}`;
  const stop = canStop(b.status) && STOP_KEYS.some((k) => can(k, b.nodePath));
  const approve = canApprove(b.status) && can("campaign.budget:manage", b.nodePath);

  let detail: string | null = null;
  if (b.status === "HALTED" && b.haltedReason) detail = HALT_WORDS[b.haltedReason] ?? null;
  else if (b.status === "DRAFT") detail = `About ${showPaise(b.estimatePaise)} in messages`;
  else if (isLive(b.status)) detail = `${n(c.sent)} of ${n(b.audience)} sent`;

  const figures =
    b.status === "DRAFT"
      ? null
      : [
          ["Sent", c.sent],
          ["Delivered", c.delivered],
          ["Read", c.read],
          ["Replied", c.replied],
          ["Not sent", c.refused + c.failed],
        ] as const;

  return (
    <li className={`pub-row bcl-row bcl-row--${b.status.toLowerCase()}`} data-broadcast={b.id} data-status={b.status}>
      <span className="pub-row__thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/dashboard/campaigns/live/broadcast/${b.id}?v=thumb`} alt="" loading="lazy" />
      </span>
      <span className="pub-row__what">
        <strong>{b.line}</strong>
        <small>
          {b.nodeName} · {people}
        </small>
      </span>
      {figures ? (
        <span className="bcl-figs tnum" aria-label="What became of it">
          {figures.map(([label, v]) => (
            <span key={label} className="bcl-fig" data-figure={label}>
              <strong>{n(v)}</strong>
              <small>{label}</small>
            </span>
          ))}
        </span>
      ) : (
        <span className="pub-row__where">
          <strong>WhatsApp</strong>
          <small>Your number</small>
        </span>
      )}
      <span className="pub-row__state">
        <span className={`pill pill--${pill.tone}`}>
          {isLive(b.status) && <span className="pill__dot" />}
          {pill.text}
        </span>
        {detail && <small className={b.status === "HALTED" ? "pub-row__why--risk" : undefined}>{detail}</small>}
      </span>
      <span className="pub-row__when tnum">{when(b.approvedAt ?? b.createdAt)}</span>
      <span className="pub-row__acts">
        {approve && (
          <ConfirmAction
            label="Approve"
            title="Send this broadcast?"
            body={
              <p>
                It goes to {people} on WhatsApp from your number, between 10 am and 9 pm: about{" "}
                {showPaise(b.estimatePaise)} in messages. Everyone is checked again before their message goes.
              </p>
            }
            confirmLabel={`Send to ${people}`}
            action={approveBroadcastAction}
            fields={{ broadcastId: b.id, back }}
            testId={`approve-${b.id}`}
          />
        )}
        {stop && (
          <form action={stopBroadcastAction}>
            <input type="hidden" name="broadcastId" value={b.id} />
            <input type="hidden" name="back" value={back} />
            <button type="submit" className="btn btn--ghost btn--sm" data-stop-broadcast={b.id}>
              Stop
            </button>
          </form>
        )}
      </span>
    </li>
  );
}
