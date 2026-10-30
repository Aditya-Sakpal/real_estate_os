import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { withTenant } from "@/lib/db";
import { captureKeyOk } from "@/lib/capture";
import { HONEYPOT_FIELD, isUuid } from "@/lib/capture-rules";
import { canPublish } from "@/lib/publish-gate";
import { adRuleFor } from "@/lib/rera-ad-rules";
import { submitEnquiryAction } from "@/app/actions/leads";
import "./enquire.css";

/**
 * The enquiry page an ad sends a buyer to when the developer has no website
 * of their own. Public: the address carries a key bound to the organisation
 * and the tower, and nothing is read before it verifies.
 *
 * It is the developer's page, not ours, so it carries their name and logo and
 * none of the console. It is read on a phone straight off a Meta or Google
 * ad, so it is one short form, large targets, and no script of its own; the
 * form posts to a server action and works before anything hydrates.
 *
 * The phase is asked of the publish gate on every view. A tower that may not
 * be advertised shows no project and takes no enquiry, and one that may shows
 * the registration it was cleared under, as every advertisement must.
 */

type Params = Promise<{ phaseId: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

/** Past this a logo is left out rather than inlined into the page. */
const MAX_LOGO_BYTES = 100 * 1024;

/** The lineage an ad's address carries, passed through to the lead. */
const LINEAGE_KEY = /^(utm_[a-z0-9_]{1,30}|gclid|fbclid|est_ref|cp)$/i;

type Place = {
  developer: string;
  project: string | null;
  tower: string;
  city: string | null;
  logo: string | null;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Null for anything that does not verify, so every failure looks the same. */
const loadPlace = cache(async (orgId: string, phaseId: string, key: string): Promise<Place | null> => {
  if (!isUuid(orgId) || !isUuid(phaseId) || !captureKeyOk(orgId, phaseId, key)) return null;
  const [rows, logos] = await withTenant(orgId, (sql) =>
    Promise.all([
      sql<{ developer: string; tower: string; project: string | null; city: string | null }[]>`
        SELECT o.display_name AS developer, ph.name AS tower, p.name AS project, r.name AS city
        FROM scope_nodes ph
        JOIN orgs o ON o.id = ph.org_id
        LEFT JOIN scope_nodes p ON p.id = ph.parent_id AND p.kind = 'PROJECT'
        LEFT JOIN scope_nodes r ON r.id = p.parent_id AND r.kind = 'REGION'
        WHERE ph.org_id = ${orgId} AND ph.id = ${phaseId} AND ph.kind = 'PHASE'`,
      // The deepest logo in force wins, as the brand kit resolves; one too
      // large to inline is dropped rather than swapped for an ancestor's.
      sql<{ media: Buffer | null; media_type: string }[]>`
        SELECT CASE WHEN octet_length(f.media) <= ${MAX_LOGO_BYTES} THEN f.media END AS media, f.media_type
        FROM brand_files f
        JOIN scope_nodes n ON n.id = f.scope_node_id
        WHERE f.org_id = ${orgId}
          AND f.role IN ('LOGO_HORIZONTAL', 'LOGO_STACKED')
          AND n.path @> (SELECT path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${phaseId})
        ORDER BY nlevel(n.path) DESC, (f.role = 'LOGO_HORIZONTAL') DESC
        LIMIT 1`,
    ]),
  );
  const row = rows[0];
  if (!row) return null;
  const logo = logos[0];
  const inline = !!logo?.media && ["image/png", "image/jpeg", "image/webp"].includes(logo.media_type);
  return {
    ...row,
    logo: logo?.media && inline ? `data:${logo.media_type};base64,${Buffer.from(logo.media).toString("base64")}` : null,
  };
});

const verdictFor = cache((orgId: string, phaseId: string) => canPublish(orgId, phaseId));

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const [{ phaseId }, q] = await Promise.all([params, searchParams]);
  const orgId = first(q.o);
  const place = await loadPlace(orgId, phaseId, first(q.k));
  if (!place) return { robots: { index: false } };
  const verdict = await verdictFor(orgId, phaseId);
  const title = verdict.ok ? [place.project, place.tower].filter(Boolean).join(" ") : place.developer;
  return { title, robots: { index: false } };
}

export default async function EnquirePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ phaseId }, q] = await Promise.all([params, searchParams]);
  const orgId = first(q.o);
  const key = first(q.k);
  const place = await loadPlace(orgId, phaseId, key);
  if (!place) notFound();

  if (first(q.done) === "1") {
    return (
      <Frame place={place}>
        <section className="enq-note">
          <span className="enq-note__mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <h1 className="enq-note__title">Thank you</h1>
          <p className="enq-note__text">We will call you shortly.</p>
        </section>
      </Frame>
    );
  }

  const verdict = await verdictFor(orgId, phaseId);
  if (!verdict.ok) {
    return (
      <Frame place={place}>
        <section className="enq-note">
          <p className="enq-note__text">Enquiries for this project are closed right now.</p>
        </section>
      </Frame>
    );
  }

  const phoneError = first(q.error) === "phone";
  const lineage = Object.entries(q)
    .filter(([k]) => LINEAGE_KEY.test(k))
    .slice(0, 12)
    .map(([k, v]) => [k, first(v).slice(0, 500)] as const)
    .filter(([, v]) => v);

  // The registering state's own label and website: a Karnataka tower's page
  // printing MahaRERA's would be the wrong authority on a public page.
  const ad = verdict.registrationNo ? adRuleFor(verdict.stateCode) : null;

  return (
    <Frame place={place}>
      <section className="enq-hero">
        {place.city && <span className="enq-hero__city">{place.city}</span>}
        <h1 className="enq-hero__title">{place.project ?? place.tower}</h1>
        {place.project && <p className="enq-hero__tower">{place.tower}</p>}
        {verdict.registrationNo && ad && (
          <p className="enq-rera">
            <span>
              {ad.label} <strong className="enq-rera__no">{verdict.registrationNo}</strong>
              {ad.permitNo && verdict.permitNo ? <> · Permit No. {verdict.permitNo}</> : null}
            </span>
            <a href={`https://${ad.website}`} target="_blank" rel="noopener noreferrer">
              {ad.website}
            </a>
          </p>
        )}
      </section>

      <form className="enq-card" action={submitEnquiryAction}>
        <h2 className="enq-card__title">Get a call back</h2>
        <p className="enq-card__sub">Leave your number and our sales team will call you.</p>

        <input type="hidden" name="o" value={orgId} />
        <input type="hidden" name="k" value={key} />
        <input type="hidden" name="phase" value={phaseId} />
        {lineage.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {/* Off screen and out of the tab order: only a bot fills it. */}
        <div aria-hidden style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
          <label>
            Leave this empty
            <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>

        <div className="enq-field">
          <label htmlFor="enq-name">Name</label>
          <input id="enq-name" className="enq-input" type="text" name="name" autoComplete="name" maxLength={120} placeholder="Your full name" defaultValue={first(q.name).slice(0, 120)} />
        </div>

        <div className="enq-field">
          <label htmlFor="enq-phone">Mobile number</label>
          <div className={`enq-phone${phoneError ? " is-invalid" : ""}`}>
            <span className="enq-phone__cc" aria-hidden>
              +91
            </span>
            <input
              id="enq-phone"
              className="enq-input"
              type="tel"
              name="phone"
              required
              autoComplete="tel"
              inputMode="tel"
              maxLength={20}
              pattern="\+?[\s\(\)\.\-]*(\d[\s\(\)\.\-]*){10,15}"
              title="Enter a 10-digit mobile number"
              placeholder="98765 43210"
              aria-invalid={phoneError || undefined}
              aria-describedby={phoneError ? "enq-phone-error" : undefined}
            />
          </div>
          {phoneError && (
            <p id="enq-phone-error" className="enq-error" role="alert">
              Enter a 10-digit mobile number
            </p>
          )}
        </div>

        <div className="enq-field">
          <label htmlFor="enq-language">Language for the call</label>
          <select id="enq-language" className="enq-input enq-select" name="language" defaultValue="hi">
            <option value="hi">हिन्दी (Hindi)</option>
            <option value="mr">मराठी (Marathi)</option>
            <option value="en">English</option>
          </select>
        </div>

        <label className="enq-consent">
          <input type="checkbox" name="consent" />
          <span>I agree to be called and messaged on WhatsApp about this enquiry</span>
        </label>

        <label className="enq-consent enq-consent--second">
          <input type="checkbox" name="ad_measurement" />
          <span>I agree that Meta and Google may be told, in coded form, if this enquiry leads to a visit or a booking</span>
        </label>

        <button type="submit" className="enq-cta">
          Request a call back
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
    </Frame>
  );
}

/** The developer's name or logo above whatever the page is saying. */
function Frame({ place, children }: { place: Place; children: React.ReactNode }) {
  return (
    <main className="enq">
      <div className="enq__wrap">
        <header className="enq-top">
          {place.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="enq-top__logo" src={place.logo} alt={place.developer} />
          ) : (
            <span className="enq-top__name">{place.developer}</span>
          )}
        </header>
        {children}
      </div>
    </main>
  );
}
