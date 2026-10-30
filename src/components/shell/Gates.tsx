import Link from "next/link";
import type { ReactNode } from "react";
import { Check, Alert, ArrowUpRight } from "@/components/icons";
import { canClear, readinessLabel, type Readiness } from "@/lib/readiness-rules";
import "./gates-mini.css";

/**
 * The six gates between a tower and an advertisement, on one row.
 *
 * This is the journey made visible. The work it names is spread over five
 * sections of the console and there was no screen that said which of them
 * were done, which order they went in, or what was left. People opened the
 * Brain, the library and Campaigns in turn to find out, and stopped when one
 * of them looked finished.
 *
 * A gate somebody cannot clear is still shown. Knowing a push is waiting on a
 * price is worth having when the person who signs prices is somebody else, so
 * it reads as state rather than as an offer.
 */
export function Gates({
  readiness,
  can,
}: {
  readiness: Readiness;
  can: (perm: string) => boolean;
}) {
  const { gates, next } = readiness;

  return (
    <div className="gates">
      <ol className="gates__row">
        {gates.map((g) => {
          const isNext = next?.key === g.key;
          const mine = canClear(g, can);
          const cls = `gate gate--${g.state}${isNext ? " gate--next" : ""}`;

          const inner = (
            <>
              <span className="gate__mark" aria-hidden>
                {g.state === "done" ? (
                  <Check size={11} />
                ) : g.state === "blocked" ? (
                  <Alert size={11} />
                ) : (
                  g.n
                )}
              </span>
              <span className="gate__body">
                <span className="gate__label">{g.label}</span>
                <span className="gate__detail">{g.detail}</span>
              </span>
            </>
          );

          // A gate nobody here can clear is not a link: pressing it would land
          // on a screen with nothing pressable on it.
          return (
            <li key={g.key} className="gates__cell">
              {mine ? (
                <Link href={g.href} className={cls} title={g.action}>
                  {inner}
                </Link>
              ) : (
                <span className={`${cls} gate--locked`}>{inner}</span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="gates__foot">
        <span
          className={
            readiness.ready
              ? "pill pill--ok"
              : readiness.blocked
                ? "pill pill--risk"
                : "pill pill--quiet"
          }
        >
          {!readiness.ready && !readiness.blocked && <span className="pill__dot" />}
          {readinessLabel(readiness)}
        </span>

        {next && canClear(next, can) && (
          <Link href={next.href} className="btn btn--ink btn--sm">
            {next.action}
            <ArrowUpRight size={13} />
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * The same six gates as one short card: the tower, a bar of six, and the one
 * thing to do next. Today lists towers beside the queue, where the full row
 * of six boxes per tower pushed the queue's neighbour off the screen.
 */
export function GatesMini({
  readiness,
  name,
  href,
  can,
  note,
}: {
  readiness: Readiness;
  name: string;
  href: string;
  can: (perm: string) => boolean;
  note?: ReactNode;
}) {
  const { gates, next } = readiness;
  return (
    <article className="gmini">
      <div className="gmini__head">
        <Link href={href} className="gmini__name">
          {name}
        </Link>
        <span className={`gmini__count${readiness.blocked ? " gmini__count--risk" : ""}`}>
          {readiness.done} of {readiness.total}
        </span>
      </div>
      <ol className="gmini__bar" aria-label={readinessLabel(readiness)}>
        {gates.map((g) => (
          <li
            key={g.key}
            className={`gmini__seg gmini__seg--${g.state}${next?.key === g.key ? " gmini__seg--next" : ""}`}
            title={`${g.label}: ${g.detail}`}
          />
        ))}
      </ol>
      {next && (
        <div className="gmini__next">
          <span className="gmini__what">
            <span className={`gmini__label${next.state === "blocked" ? " gmini__label--risk" : ""}`}>{next.label}</span>
            <span className="gmini__detail">{next.detail}</span>
          </span>
          {canClear(next, can) ? (
            <Link href={next.href} className="btn btn--ink btn--sm">
              {next.action}
              <ArrowUpRight size={13} />
            </Link>
          ) : (
            <span className="pill pill--quiet">View only</span>
          )}
        </div>
      )}
      {note}
    </article>
  );
}
