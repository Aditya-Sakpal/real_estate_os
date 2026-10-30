import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import {
  numberAreas,
  numbersPage,
  searchNumbers,
  type Area,
  type NumberView,
  type Place,
  type SearchResult,
} from "@/lib/calling-numbers";
import { showPhone } from "@/lib/call-rules";
import { KYC_WORDS, MOBILE_SERIES } from "@/lib/calling-number-rules";
import { KycForm } from "./KycForm";
import type { KycView } from "@/lib/calling-kyc";
import {
  linkSarvamConnectionAction,
  placeCallingNumberAction,
  releaseCallingNumberAction,
  rentCallingNumberAction,
  verifyBusinessAction,
} from "@/app/actions/calling-numbers";
import { PageHead } from "@/components/shell/PageHead";
import { ConfirmAction } from "@/components/ConfirmAction";
import { RentConfirm } from "./RentConfirm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { ArrowUpRight, Phone } from "@/components/icons";
import "../connections/whatsapp/whatsapp.css";
import "./numbers.css";

/**
 * The developer's own calling numbers: the number a buyer sees when the AI
 * or a sales person calls them.
 *
 * It opens read-only: the dark Needs you card first (a number nobody
 * placed), then the numbers, each with where it calls for. Getting a number
 * is its own view (search a city, pick one, choose where it is used); getting
 * one asks first, because it is paid for at once, and releasing one asks
 * first, because the number stops working at once.
 */

const PAGE = "/dashboard/settings/calling-numbers";

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
const placeLabel = (p: { kind: string; name: string }) =>
  p.kind === "ORG"
    ? "Whole organisation"
    : p.kind === "ENTITY"
      ? `${p.name} (entity)`
      : p.name;
const one = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? "";

export default async function CallingNumbersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("integration:manage")) redirect("/dashboard/settings");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const error = readFlash(q, "error");
  const done = readFlash(q, "done");
  // Back from the verification page: ask where it stands at once.
  const page = await numbersPage(orgId, { refreshKyc: one(q.kyc) === "back" });

  // No number is offered before the business is verified.
  if (one(q.get) === "1" && page.kycProblem) redirect(PAGE);
  if (one(q.get) === "1") {
    const query = one(q.q).trim().slice(0, 60);
    const starts = one(q.starts).replace(/[^0-9]/g, "").slice(0, 6);
    const [found, areas] = await Promise.all([
      query ? searchNumbers(query, starts, { kyc: true }) : Promise.resolve(null),
      numberAreas(),
    ]);
    return <GetView page={page} query={query} starts={starts} areas={areas} found={found} error={error} />;
  }

  const moving = one(q.move) || null;
  const editingConn = one(q.conn) || null;
  const unplaced = page.numbers.filter((n) => !n.place);
  const canGet = page.canRent && !page.problem && !page.kycProblem;
  const included =
    page.allowed !== null
      ? ` · ${page.numbers.length} of ${page.allowed} in your plans`
      : "";

  return (
    <>
      <PageHead
        title={
          <>
            <span className="conn__titlemark wa-mark">
              <Phone size={18} />
            </span>
            Calling <span className="em">numbers</span>
          </>
        }
        meta={
          page.numbers.length
            ? `${count(page.numbers.length, "number")}${included}`
            : "The number buyers see when you or the AI call them."
        }
        back={{ label: "Settings", href: "/dashboard/settings" }}
        action={
          canGet ? (
            <Link
              href={`${PAGE}?get=1`}
              className="btn btn--ink"
              data-get-number
            >
              Get a number
              <ArrowUpRight size={14} />
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn--ink"
              disabled
              aria-disabled="true"
              title={page.kycProblem ?? page.problem ?? "Getting a number isn't switched on yet."}
            >
              Get a number
            </button>
          )
        }
      />

      <Flash text={error} name="error" />
      <Flash text={done} name="done" tone="info" />
      {page.canRent && page.kycProblem && <KycCard kyc={page.kyc} email={viewer.email} />}
      {(page.problem || !page.canRent) && (
        <p className="note note--info" role="status" data-number-limit>
          {page.canRent
            ? page.problem
            : "Getting a number isn't switched on yet."}
        </p>
      )}

      {unplaced.length > 0 && (
        <section
          className="conn conn--needs wa-needs"
          aria-labelledby="cn-needs-h"
          data-numbers-needs
        >
          <header className="conn__head">
            <div className="conn__id">
              <h2 id="cn-needs-h">Needs you</h2>
              <p>
                {unplaced.length === 1
                  ? "This number makes no calls until it has a place."
                  : "These numbers make no calls until they have a place."}
              </p>
            </div>
          </header>
          <ul className="wa-needs__list">
            {unplaced.map((n) => (
              <li key={n.id} data-needs-place={n.id}>
                <span className="wa-needs__what">
                  <strong className="tnum">
                    Where is {showPhone(n.number)} used?
                  </strong>
                  {n.city && <span>{n.city}</span>}
                </span>
                <PlaceForm number={n} places={page.places} tone="light" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {page.numbers.length === 0 ? (
        <section className="card empty cn-empty" aria-labelledby="cn-list-h" data-no-numbers>
          <span className="empty__mark">
            <Phone size={18} />
          </span>
          <h2 id="cn-list-h">No calling number yet</h2>
          <p className="sub">
            {page.onShared
              ? "Calls use Sales Desk’s number for now."
              : "Get a number to call buyers from your own."}
          </p>
        </section>
      ) : (
      <section className="card wa-card" aria-labelledby="cn-list-h">
        <div className="card__head">
          <h2 id="cn-list-h">Your numbers</h2>
          {page.onShared && (
            <span className="pill pill--quiet">
              Calls use Sales Desk&rsquo;s number for now
            </span>
          )}
        </div>
        {(
          <ul className="acct-list">
            {page.numbers.map((n) => (
              <li
                key={n.id}
                className="wa-num cn-num"
                data-calling-number={n.id}
              >
                <span className="acct__id">
                  <strong className="tnum">{showPhone(n.number)}</strong>
                  <small>{n.city ?? "India"}</small>
                </span>
                <span className="wa-num__where">
                  {moving === n.id ? (
                    <>
                      <PlaceForm number={n} places={page.places} tone="ink" />
                      <Link href={PAGE} className="wa-num__move">
                        Cancel
                      </Link>
                    </>
                  ) : (
                    <>
                      <span className="pill pill--quiet">
                        {n.place ? placeLabel(n.place) : "Not used yet"}
                      </span>
                      {n.place && (
                        <Link
                          href={`${PAGE}?move=${n.id}`}
                          className="wa-num__move"
                          data-move-number={n.id}
                        >
                          Move
                        </Link>
                      )}
                    </>
                  )}
                </span>
                <dl className="cn-num__more">
                  <div>
                    <dt>Incoming calls address</dt>
                    <dd>
                      {n.inbound ? (
                        <code className="cn-num__addr" data-inbound-address={n.id}>
                          {n.inbound}
                        </code>
                      ) : (
                        <span className="formfield__unset">Not set up yet</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Sarvam connection</dt>
                    <dd>
                      {editingConn === n.id ? (
                        <form action={linkSarvamConnectionAction} className="cn-conn">
                          <input type="hidden" name="numberId" value={n.id} />
                          <label className="sr-only" htmlFor={`conn-${n.id}`}>
                            Sarvam connection for {showPhone(n.number)}
                          </label>
                          <input
                            id={`conn-${n.id}`}
                            name="connectionId"
                            className="formfield__input"
                            defaultValue={n.connectionId ?? ""}
                            placeholder="e.g. conn_4f2a9c"
                            maxLength={200}
                            data-connection-field={n.id}
                          />
                          <button type="submit" className="btn btn--ink btn--sm" data-save-connection={n.id}>
                            Save
                          </button>
                          <Link href={PAGE} className="wa-num__move">
                            Cancel
                          </Link>
                        </form>
                      ) : (
                        <>
                          <span data-connection={n.id}>{n.connectionId ?? "Sales Desk’s"}</span>{" "}
                          <Link href={`${PAGE}?conn=${n.id}`} className="wa-num__move" data-change-connection={n.id}>
                            Change
                          </Link>
                        </>
                      )}
                    </dd>
                  </div>
                </dl>
                <span className="cn-num__release">
                  <ConfirmAction
                    label="Release"
                    title={`Release ${showPhone(n.number)}?`}
                    body={
                      <p>
                        Calls stop going out from {showPhone(n.number)} at once
                        {n.place ? ` for ${placeLabel(n.place)}` : ""}, and
                        buyers who call it back no longer reach you. You may not
                        get the same number again.
                      </p>
                    }
                    confirmLabel="Release the number"
                    action={releaseCallingNumberAction}
                    fields={{ numberId: n.id }}
                    tone="risk"
                    testId={`release-${n.id}`}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Verifying the business, once, before the first number, on this screen:
 * the documents go to the phone provider's checks, and only a person's
 * Aadhaar is given on DigiLocker's own page.
 */
function KycCard({ kyc, email }: { kyc: KycView | null; email: string }) {
  // Vobiz calls a fresh sub-account "pending" before anything is sent, so
  // only a document still under its check says "being checked".
  const checking = !!kyc && Object.values(kyc.verifications).includes("pending");
  const failed = !!kyc && Object.values(kyc.verifications).includes("failed");
  return (
    <section className="card wa-card cn-kyc" aria-labelledby="cn-kyc-h" data-kyc={kyc?.status ?? "none"}>
      <div className="card__head">
        <h2 id="cn-kyc-h">Verify your business</h2>
        {checking && <span className="pill pill--quiet">{KYC_WORDS.pending}</span>}
        {failed && !checking && <span className="pill pill--warn">{KYC_WORDS.failed}</span>}
      </div>
      <p className="sub">
        {checking ? "Your details are being checked. Numbers open as soon as it passes." : "Needed once before your first number."}
      </p>
      {checking ? (
        <Link href={`${PAGE}?kyc=back`} className="btn btn--ghost" data-kyc-recheck>
          Check again
        </Link>
      ) : (
        <KycForm action={verifyBusinessAction} type={kyc?.businessType ?? "private_limited"} email={kyc?.email ?? email} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function PlaceForm({
  number,
  places,
  tone,
}: {
  number: NumberView;
  places: Place[];
  tone: "light" | "ink";
}) {
  return (
    <form action={placeCallingNumberAction} className="wa-needs__form wa-place">
      <input type="hidden" name="numberId" value={number.id} />
      <label>
        <span className="sr-only">
          Where {showPhone(number.number)} is used
        </span>
        <select
          name="nodeId"
          className="select-field"
          defaultValue={
            number.place?.id ?? places.find((p) => p.kind === "ORG")?.id ?? ""
          }
          required
        >
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {placeLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className={`btn ${tone === "light" ? "btn--light" : "btn--ink"} btn--sm`}
        data-save-place={number.id}
      >
        Save
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

function GetView({
  page,
  query,
  starts,
  areas,
  found,
  error,
}: {
  page: Awaited<ReturnType<typeof numbersPage>>;
  query: string;
  starts: string;
  areas: Area[] | null;
  found: SearchResult | null;
  error: string | null;
}) {
  const taken = new Set(
    page.numbers.filter((n) => n.place).map((n) => n.place!.id),
  );
  const freePlaces = page.places.filter((p) => !taken.has(p.id));
  const numbers = found?.ok ? found.numbers : [];
  const foundCity = found?.ok ? found.city : null;
  const blocked = !page.canRent
    ? "Getting a number isn't switched on yet."
    : page.problem;
  const canRent = !blocked && numbers.length > 0;

  return (
    <>
      <PageHead
        title={
          <>
            Get a <span className="em">number</span>
          </>
        }
        meta={
          found?.ok
            ? `${count(numbers.length, "number")} ${found.city ? `in ${found.city}` : `starting 0${found.code}`}`
            : areas?.length
              ? "Choose an area."
              : "Search a city or an area code."
        }
        back={{ label: "Calling numbers", href: PAGE }}
        action={
          canRent ? <RentConfirm formId="rent-form" /> : null
        }
      />
      <Flash text={error} name="error" />
      {blocked && (
        <p className="note note--info" role="status">
          {blocked}
        </p>
      )}

      {page.canRent && (
        <section className="card wa-card" aria-labelledby="cn-search-h">
          <div className="card__head">
            <h2 id="cn-search-h">Search</h2>
          </div>
          <form method="get" action={PAGE} className="cn-search" role="search">
            <input type="hidden" name="get" value="1" />
            {areas?.length ? (
              <label className="cn-search__field">
                <span className="formfield__label">Area</span>
                <select
                  name="q"
                  className="formfield__input"
                  defaultValue={areas.some((a) => a.code === query) ? query : areas[0].code}
                  required
                  data-number-search
                >
                  {areas.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code === MOBILE_SERIES ? a.label : `${a.label} (0${a.code})`} · {a.free.toLocaleString("en-IN")} free
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="cn-search__field">
                <span className="formfield__label">City or area code</span>
                <input
                  name="q"
                  className="formfield__input"
                  defaultValue={query}
                  placeholder="e.g. Pune or 20"
                  maxLength={60}
                  required
                  data-number-search
                />
              </label>
            )}
            <label className="cn-search__field cn-search__starts">
              <span className="formfield__label">Starts with (optional)</span>
              <input
                name="starts"
                className="formfield__input tnum"
                defaultValue={starts}
                placeholder="e.g. 642"
                inputMode="numeric"
                maxLength={6}
                pattern="[0-9]*"
              />
            </label>
            <button type="submit" className="btn btn--ghost">
              Search
            </button>
          </form>
          {found && !found.ok && (
            <p className="note note--risk" role="alert" data-search-refused>
              {found.message}
            </p>
          )}
          {found?.ok && numbers.length === 0 && (
            <p className="formfield__unset">
              {starts
                ? "No free numbers start with those digits. Clear them or try others."
                : "No numbers free there right now. Choose another area."}
            </p>
          )}
        </section>
      )}

      {numbers.length > 0 && (
        <form
          id="rent-form"
          action={rentCallingNumberAction}
          className="card wa-card"
          aria-labelledby="cn-pick-h"
        >
          <input type="hidden" name="q" value={query} />
          <input type="hidden" name="starts" value={starts} />
          <div className="card__head">
            <h2 id="cn-pick-h">Choose a number</h2>
          </div>
          <fieldset className="cn-pick" disabled={!!blocked}>
            <legend className="sr-only">Number</legend>
            {numbers.map((n, i) => (
              <label
                key={n.number}
                className="cn-pick__row"
                data-available={n.number}
              >
                <input
                  type="radio"
                  name="pick"
                  value={`${n.number}|${n.city ?? foundCity ?? ""}`}
                  defaultChecked={i === 0}
                  required
                />
                <strong className="tnum">{showPhone(n.number)}</strong>
                <small>{n.city ?? foundCity ?? ""}</small>
              </label>
            ))}
          </fieldset>
          <label className="cn-where">
            <span className="formfield__label">Used for</span>
            <select
              name="nodeId"
              className="select-field"
              defaultValue={freePlaces[0]?.id ?? ""}
              disabled={!!blocked}
            >
              <option value="">Choose later</option>
              {freePlaces.map((p) => (
                <option key={p.id} value={p.id}>
                  {placeLabel(p)}
                </option>
              ))}
            </select>
          </label>
        </form>
      )}
    </>
  );
}
