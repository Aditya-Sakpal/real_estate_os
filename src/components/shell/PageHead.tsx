import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "@/components/icons";

/**
 * Every screen's header, in one place.
 *
 * Six deep screens already shared this shape: a back pill, a title, one line
 * of state, and the controls up at the top where somebody looks for them.
 * Eleven others wrote their own as an inline-styled div, which is why the
 * primary action ended up somewhere different on nearly every one of them:
 * at the top on one screen, inside the first card on another, and below the
 * list it applied to on a third. This is the same markup those six already
 * use, so there is one header rather than two that resemble each other.
 *
 * `title` takes the italic-serif emphasis word as a node, so the references'
 * signature pairing stays deliberate rather than automatic.
 */
export function PageHead({
  title,
  meta,
  action,
  back,
}: {
  title: ReactNode;
  /** Where you are and what is here. One line, state only. */
  meta?: ReactNode;
  /** The one thing this screen is for. Null when the viewer cannot do it. */
  action?: ReactNode;
  /** The screen above this one, when there is one. */
  back?: { label: string; href: string };
}) {
  return (
    <header className="pagehead">
      <div className="pagehead__id">
        {back && (
          <Link href={back.href} className="backlink" data-back>
            <ArrowLeft size={13} />
            {back.label}
          </Link>
        )}
        <h1 style={back ? { marginTop: 8 } : undefined}>{title}</h1>
        {meta && (
          <p className="sub" style={{ marginTop: 6 }}>
            {meta}
          </p>
        )}
      </div>
      {action && <div className="pagehead__acts">{action}</div>}
    </header>
  );
}
