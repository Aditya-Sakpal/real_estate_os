import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { passFor } from "@/lib/checkin";
import { offerLabel } from "@/lib/slot-rules";
import "../../../enquire/[phaseId]/enquire.css";
import "./pass.css";

/**
 * A buyer's visit pass, the link their WhatsApp confirmation carries. Public:
 * the address holds a proof bound to the organisation and the visit, and
 * nothing is read before it verifies. It names the place and the time and
 * shows the code the site team scans at the gate; nothing about the buyer.
 */

type Params = Promise<{ orgId: string; visitId: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export const metadata: Metadata = { title: "Visit pass", robots: { index: false } };

export default async function PassPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ orgId, visitId }, q] = await Promise.all([params, searchParams]);
  const pass = await passFor(orgId, visitId, first(q.t));
  if (!pass) notFound();

  const live = pass.status === "CONFIRMED" || pass.status === "NO_SHOW";
  const inside = pass.status === "ON_SITE" || pass.status === "VISITED";
  const svg = live
    ? await QRCode.toString(pass.payload, { type: "svg", errorCorrectionLevel: "M", margin: 0, color: { dark: "#14161b", light: "#0000" } })
    : null;

  return (
    <main className="enq">
      <div className="enq__wrap">
        <header className="enq-top">
          <span className="enq-top__name">{pass.developer}</span>
        </header>

        <section className="enq-hero">
          <span className="enq-hero__city">Site visit</span>
          <h1 className="enq-hero__title">{pass.place}</h1>
          <p className="enq-hero__tower">{offerLabel(pass.at)}</p>
        </section>

        {svg ? (
          <section className="enq-card pass-card">
            <div className="pass-code" role="img" aria-label="Visit pass code" dangerouslySetInnerHTML={{ __html: svg }} />
            <p className="pass-say">Show this at the gate</p>
          </section>
        ) : (
          <section className="enq-note">
            <p className="enq-note__text">
              {inside ? "You are checked in. Welcome." : pass.status === "REQUESTED" ? "This visit is not confirmed yet." : "This visit is no longer on."}
            </p>
          </section>
        )}

        {live && pass.directions && (
          <a className="enq-cta pass-way" href={pass.directions} target="_blank" rel="noopener noreferrer">
            Directions
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
        )}
      </div>
    </main>
  );
}
