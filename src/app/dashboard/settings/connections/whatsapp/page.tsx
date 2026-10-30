import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { servablePlaces } from "@/lib/connect";
import { listWhatsApp, whatsappReadyToConnect, type AccountView, type NumberView } from "@/lib/wa-numbers";
import { QUALITY_PILL, TEMPLATE_PILL, needsSubmitting, tierLabel } from "@/lib/wa-rules";
import { signupConfig } from "@/lib/whatsapp";
import { showPhone } from "@/lib/call-rules";
import {
  checkWhatsAppAction,
  disconnectWhatsAppAction,
  enterPinAction,
  placeNumberAction,
  submitTemplatesAction,
} from "@/app/actions/whatsapp";
import { PageHead } from "@/components/shell/PageHead";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { ArrowUpRight, Chat } from "@/components/icons";
import { WhatsAppSignup } from "./WhatsAppSignup";
import "./whatsapp.css";

/**
 * The developer's own WhatsApp number: connect it through Meta's sign-in,
 * see whether it can send, and which of our messages Meta has approved.
 *
 * It opens on the work. Not connected: two tiles (keep the number already in
 * the WhatsApp Business app, or a new one) and the button that opens Meta.
 * Connected: the dark Needs you card first (access that stopped working, a
 * PIN only the owner knows, a number nobody placed, billing Meta will stop,
 * quality, refusals), then the numbers read-only, then every message and
 * where Meta stands on it. Moving a number is a decision, so it opens one
 * row at a time.
 */

const LANGUAGE: Record<string, string> = { en: "English", hi: "Hindi", mr: "Marathi" };
const KIND: Record<string, string> = { UTILITY: "Service", MARKETING: "Promotional", AUTHENTICATION: "Sign-in code" };

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })
    : null;

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

type Place = { id: string; kind: string; name: string; path: string };

const placeLabel = (p: Place) => (p.kind === "ORG" ? "Whole organisation" : p.kind === "ENTITY" ? `${p.name} (entity)` : p.name);

export default async function WhatsAppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("integration:manage")) redirect("/dashboard/settings/connections");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const error = readFlash(q, "error");
  const done = readFlash(q, "done");

  const [accounts, places] = await Promise.all([listWhatsApp(orgId), servablePlaces(orgId)]);
  const cfg = signupConfig();
  const signup = {
    appId: cfg?.appId ?? null,
    configId: cfg?.configId ?? null,
    solutionId: cfg?.solutionId ?? null,
    version: cfg?.version ?? "v26.0",
    unavailable: whatsappReadyToConnect() ? null : "Connecting WhatsApp is not switched on for Sales Desk yet.",
  };
  const keepAppNumber = q.number !== "new";

  if (!accounts.length || q.add === "1") {
    return <ConnectView adding={accounts.length > 0} keepAppNumber={keepAppNumber} signup={signup} error={error} />;
  }

  const moving = typeof q.move === "string" ? q.move : null;
  const pending = accounts
    .filter((a) => a.status === "CONNECTED")
    .map((a) => ({ id: a.id, n: a.templates.filter((t) => needsSubmitting(t.state)).length }))
    .find((a) => a.n > 0);
  const first = accounts[0];

  return (
    <>
      <PageHead
        title={
          <>
            <span className="conn__titlemark wa-mark">
              <Chat size={18} />
            </span>
            WhatsApp <span className="em">numbers</span>
          </>
        }
        meta={[`Connected on ${when(first.connectedAt)}`, first.lastCheckedAt ? `· checked with Meta ${when(first.lastCheckedAt)}` : null]
          .filter(Boolean)
          .join(" ")}
        back={{ label: "Connected accounts", href: "/dashboard/settings/connections" }}
        action={
          pending ? (
            <>
              <Link href="/dashboard/settings/connections/whatsapp?add=1" className="btn btn--ghost" data-add-number>
                Add a number
              </Link>
              <form action={submitTemplatesAction}>
                <input type="hidden" name="accountId" value={pending.id} />
                <button type="submit" className="btn btn--ink" data-submit-templates>
                  Send {count(pending.n, "message")} to Meta
                  <ArrowUpRight size={14} />
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/dashboard/settings/connections/whatsapp?add=1" className="btn btn--ghost" data-add-number>
                Add a number
              </Link>
              <form action={checkWhatsAppAction}>
                <button type="submit" className="btn btn--ink" data-check-whatsapp>
                  Check with Meta
                </button>
              </form>
            </>
          )
        }
      />

      <Flash text={error} name="error" />
      <Flash text={done} name="done" tone="info" />

      <NeedsYou accounts={accounts} places={places} signup={signup} />

      {accounts.map((a) => (
        <div key={a.id} className="wa-account" data-whatsapp-account={a.id}>
          <Numbers account={a} places={places} moving={moving} />
          <Messages account={a} />
          <div className="wa-foot">
            <span className="wa-foot__who">{a.name ? `WhatsApp account: ${a.name}` : null}</span>
            <ConfirmAction
              label="Disconnect WhatsApp"
              title="Disconnect this WhatsApp account?"
              body={
                <p>
                  Buyers stop getting messages from {a.numbers.map((n) => showPhone(n.display)).join(", ") || "its numbers"}. Nothing changes on
                  your phone or in the WhatsApp Business app.
                </p>
              }
              confirmLabel="Disconnect WhatsApp"
              action={disconnectWhatsAppAction}
              fields={{ accountId: a.id }}
              tone="risk"
              testId="disconnect-whatsapp"
            />
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

type Signup = { appId: string | null; configId: string | null; solutionId: string | null; version: string; unavailable: string | null };

function ConnectView({ adding, keepAppNumber, signup, error }: { adding: boolean; keepAppNumber: boolean; signup: Signup; error: string | null }) {
  const base = adding ? "/dashboard/settings/connections/whatsapp?add=1&" : "/dashboard/settings/connections/whatsapp?";
  return (
    <>
      <PageHead
        title={
          adding ? (
            <>
              Add a <span className="em">number</span>
            </>
          ) : (
            <>
              Connect your <span className="em">WhatsApp</span>
            </>
          )
        }
        meta="Buyers hear from your own number, in your business name."
        back={
          adding
            ? { label: "WhatsApp numbers", href: "/dashboard/settings/connections/whatsapp" }
            : { label: "Connected accounts", href: "/dashboard/settings/connections" }
        }
        action={<WhatsAppSignup {...signup} keepAppNumber={keepAppNumber} label="Connect WhatsApp" />}
      />
      <Flash text={error} name="error" />

      <nav className="wa-pick" aria-label="Which number">
        <Link
          href={`${base}number=app`}
          className={`wa-pick__tile${keepAppNumber ? " wa-pick__tile--on" : ""}`}
          aria-current={keepAppNumber ? "true" : undefined}
          data-pick-number="app"
        >
          <strong>Keep your current number</strong>
          <span>It stays in the WhatsApp Business app on your phone, and your chats stay where they are.</span>
        </Link>
        <Link
          href={`${base}number=new`}
          className={`wa-pick__tile${!keepAppNumber ? " wa-pick__tile--on" : ""}`}
          aria-current={!keepAppNumber ? "true" : undefined}
          data-pick-number="new"
        >
          <strong>Use a new number</strong>
          <span>A number that is not on WhatsApp yet. Meta sends it a code to confirm.</span>
        </Link>
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------

/** The one dark card: what stops a message reaching a buyer, and the one control for each. */
function NeedsYou({ accounts, places, signup }: { accounts: AccountView[]; places: Place[]; signup: Signup }) {
  const broken = accounts.filter((a) => a.status === "BROKEN");
  const numbers = accounts.flatMap((a) => a.numbers.map((n) => ({ n, a })));
  const live = numbers.filter(({ a }) => a.status === "CONNECTED");
  const pin = live.filter(({ n }) => n.needs?.code === "PIN");
  const unplaced = live.filter(({ n }) => n.needs?.code === "PLACE");
  const other = live.filter(({ n }) => n.needs && n.needs.code !== "PIN" && n.needs.code !== "PLACE");
  const refused = accounts.reduce((s, a) => s + a.templates.filter((t) => t.state === "REFUSED").length, 0);
  const items = broken.length + pin.length + unplaced.length + other.length + (refused ? 1 : 0);
  if (!items) return null;

  return (
    <section className="conn conn--needs wa-needs" aria-labelledby="wa-needs-h" data-whatsapp-needs>
      <header className="conn__head">
        <div className="conn__id">
          <h2 id="wa-needs-h">Needs you</h2>
          <p>{count(items, "thing")} before every buyer gets their messages.</p>
        </div>
      </header>
      <ul className="wa-needs__list">
        {broken.map((a) => (
          <li key={a.id}>
            <span className="wa-needs__what">
              <strong>WhatsApp stopped accepting our access</strong>
              <span>Nothing goes out from {a.numbers.length === 1 ? showPhone(a.numbers[0].display) : "these numbers"} until it is connected again.</span>
            </span>
            <WhatsAppSignup {...signup} keepAppNumber={a.numbers.some((n) => n.onApp)} label="Connect again" tone="light" />
          </li>
        ))}
        {pin.map(({ n }) => (
          <li key={n.id} data-needs-pin={n.id}>
            <span className="wa-needs__what">
              <strong>{showPhone(n.display)} has a two-step PIN</strong>
              <span>{n.needs?.text}</span>
            </span>
            <form action={enterPinAction} className="wa-needs__form">
              <input type="hidden" name="numberId" value={n.id} />
              <label>
                <span className="sr-only">Two-step PIN for {showPhone(n.display)}</span>
                <input
                  name="pin"
                  className="formfield__input wa-pin tnum"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  placeholder="6 digits"
                />
              </label>
              <button type="submit" className="btn btn--light btn--sm">
                Finish setting up
              </button>
            </form>
          </li>
        ))}
        {unplaced.map(({ n }) => (
          <li key={n.id} data-needs-place={n.id}>
            <span className="wa-needs__what">
              <strong>Where is {showPhone(n.display)} used?</strong>
              <span>It sends nothing until it has a place.</span>
            </span>
            <PlaceForm number={n} places={places} tone="light" />
          </li>
        ))}
        {other.map(({ n }) => (
          <li key={n.id}>
            <span className="wa-needs__what">
              <strong>{showPhone(n.display)}</strong>
              <span>{n.needs?.text}</span>
            </span>
          </li>
        ))}
        {refused > 0 && (
          <li>
            <span className="wa-needs__what">
              <strong>Meta did not approve {count(refused, "message")}</strong>
              <span>Buyers do not get {refused === 1 ? "it" : "them"} until Meta does. The reason is beside each.</span>
            </span>
            <a href="#wa-messages" className="btn btn--light btn--sm">
              See which
            </a>
          </li>
        )}
      </ul>
    </section>
  );
}

function PlaceForm({ number, places, tone }: { number: NumberView; places: Place[]; tone: "light" | "ink" }) {
  return (
    <form action={placeNumberAction} className="wa-needs__form wa-place">
      <input type="hidden" name="numberId" value={number.id} />
      <label>
        <span className="sr-only">Where {showPhone(number.display)} is used</span>
        <select name="nodeId" className="select-field" defaultValue={number.place?.id ?? places.find((p) => p.kind === "ORG")?.id ?? ""} required>
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {placeLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={`btn ${tone === "light" ? "btn--light" : "btn--ink"} btn--sm`} data-save-place={number.id}>
        Save
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Numbers({ account, places, moving }: { account: AccountView; places: Place[]; moving: string | null }) {
  return (
    <section className="card wa-card" aria-labelledby={`wa-numbers-${account.id}`}>
      <div className="card__head">
        <h2 id={`wa-numbers-${account.id}`}>Numbers</h2>
        <span className={`pill pill--${account.status === "BROKEN" ? "risk" : "ok"}`}>
          <span className="pill__dot" />
          {account.status === "BROKEN" ? "Stopped working" : "Connected"}
        </span>
      </div>
      {account.numbers.length === 0 ? (
        <p className="formfield__unset">This WhatsApp account has no number yet. Add one in WhatsApp Manager, then check with Meta.</p>
      ) : (
        <ul className="acct-list">
          {account.numbers.map((n) => {
            const q = QUALITY_PILL[n.quality];
            return (
              <li key={n.id} className="wa-num" data-number={n.id}>
                <span className="acct__id">
                  <strong className="tnum">{showPhone(n.display)}</strong>
                  <small>
                    {n.name || "Name not approved yet"}
                    {n.onApp ? " · also in the WhatsApp Business app" : ""}
                  </small>
                </span>
                <span className="wa-num__facts">
                  <span className={`pill pill--${q.tone}`}>{q.text}</span>
                  <span className="wa-num__limit tnum">{tierLabel(n.limit)}</span>
                </span>
                <span className="wa-num__where">
                  {moving === n.id ? (
                    <>
                      <PlaceForm number={n} places={places} tone="ink" />
                      <Link href="/dashboard/settings/connections/whatsapp" className="wa-num__move">
                        Cancel
                      </Link>
                    </>
                  ) : (
                    <>
                      <span className="pill pill--quiet">{n.place ? (n.place.id === places.find((p) => p.kind === "ORG")?.id ? "Whole organisation" : n.place.name) : "Not used yet"}</span>
                      {n.active && (
                        <Link href={`/dashboard/settings/connections/whatsapp?move=${n.id}`} className="wa-num__move" data-move-number={n.id}>
                          Move
                        </Link>
                      )}
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Messages({ account }: { account: AccountView }) {
  const approved = account.templates.filter((t) => t.state === "SENDS").length;
  return (
    <section className="card wa-card" id="wa-messages" aria-labelledby={`wa-messages-${account.id}`}>
      <div className="card__head">
        <h2 id={`wa-messages-${account.id}`}>Messages</h2>
        <span className="pill pill--quiet tnum">
          {approved.toLocaleString("en-IN")} of {account.templates.length.toLocaleString("en-IN")} approved
        </span>
      </div>
      <table className="wa-msgs">
        <thead>
          <tr>
            <th scope="col">Message</th>
            <th scope="col">Language</th>
            <th scope="col">Kind</th>
            <th scope="col">With Meta</th>
          </tr>
        </thead>
        <tbody>
          {account.templates.map((t) => {
            const pill = TEMPLATE_PILL[t.state];
            return (
              <tr key={`${t.name}|${t.language}`} data-template={t.name} data-state={t.state}>
                <td>
                  <span className="wa-msgs__label">{t.label}</span>
                  {t.reason && <span className="wa-msgs__why">{t.reason}</span>}
                </td>
                <td>{LANGUAGE[t.language] ?? t.language}</td>
                <td>{KIND[t.category] ?? t.category}</td>
                <td>
                  <span className={`pill pill--${pill.tone}`}>{pill.text}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
