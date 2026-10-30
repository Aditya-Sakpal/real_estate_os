import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getViewer } from "@/lib/console";
import { loadConnection, providerReady, servablePlaces, type AccountView } from "@/lib/connect";
import {
  ACCOUNT_KINDS,
  accountKindLabel,
  HEALTH_PILL,
  PROVIDERS,
  providerFromSlug,
  providerSlug,
  showRupees,
  type AccountKind,
  type Choice,
} from "@/lib/connect-rules";
import {
  checkConnectionAction,
  chooseAccountsAction,
  disconnectAction,
  setDailyCapAction,
  setQualifiedBiddingAction,
} from "@/app/actions/connect";
import { biddingStates } from "@/lib/bidding";
import { QUALIFIED_BID_LEADS } from "@/lib/attribution-rules";
import { PageHead } from "@/components/shell/PageHead";
import { ProviderMark } from "@/components/ProviderMark";
import { ConfirmAction } from "@/components/ConfirmAction";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { ArrowUpRight, Check } from "@/components/icons";
import { BudgetSwitch } from "./BudgetSwitch";
import "./budget.css";

/**
 * One provider's accounts, and where each is used.
 *
 * It opens read-only once something is chosen, because the accounts in use
 * are live: changing them changes where tomorrow's posts go. Choosing is a
 * decision, behind "Change accounts". A first consent opens straight onto the
 * choice, since there is nothing live to protect yet.
 *
 * Three powers on one screen and each is its own key: choosing and
 * disconnecting are `integration:manage`, the daily limit on an ad account
 * is `campaign.budget:manage`, and anybody who may publish can read it.
 * Moving budget between an account's ads automatically is the budget key
 * too; everybody else sees whether it is on.
 */

const VIEW_KEYS = ["integration:manage", "campaign:publish", "campaign.budget:manage"];
const FORM = "accountsform";

const on = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : null;

const AD_KINDS: AccountKind[] = ["META_AD_ACCOUNT", "GOOGLE_ADS_CUSTOMER"];

/** Whether a Facebook Page's lead forms reach us, as Meta answered when it was chosen. */
function leadFormsLine(a: AccountView): { tone: "yes" | "no" | "unknown"; text: string } | null {
  if (a.kind !== "FACEBOOK_PAGE") return null;
  if (a.leadForms === true) return { tone: "yes", text: "Lead forms arrive" };
  if (a.leadForms === false) return { tone: "no", text: "Meta refused its lead forms" };
  return { tone: "unknown", text: "Lead forms not set up" };
}

/** A line about one offered account, in the provider's own terms. */
function describe(c: Choice | AccountView): string | null {
  const d = c.detail;
  const parts: string[] = [];
  if (c.kind === "INSTAGRAM" && d.page_name) parts.push(`Through ${d.page_name}`);
  if (c.kind === "FACEBOOK_PAGE" && d.instagram_id) parts.push("Instagram linked");
  if (d.business) parts.push(String(d.business));
  if (d.manager_name) parts.push(`Through ${d.manager_name}`);
  if (d.account_name) parts.push(String(d.account_name));
  if (d.city) parts.push(String(d.city));
  if (d.currency) parts.push(String(d.currency));
  if (d.test) parts.push("Test account");
  return parts.length ? parts.join(" · ") : null;
}

export default async function ProviderPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!VIEW_KEYS.some((k) => viewer.authz.can(k))) redirect("/dashboard/settings");

  const provider = providerFromSlug((await params).provider);
  if (!provider) notFound();
  const q = await searchParams;
  // Messages print only when they carry our signature.
  const error = readFlash(q, "error");
  const note = readFlash(q, "note");
  const done = readFlash(q, "done");
  const orgId = viewer.state.org.id;
  const def = PROVIDERS.find((p) => p.key === provider)!;
  const slug = providerSlug(provider);

  const [connection, places] = await Promise.all([loadConnection(orgId, provider), servablePlaces(orgId)]);
  if (!connection) redirect("/dashboard/settings/connections");

  const mayManage = viewer.authz.can("integration:manage");
  const mayBudget = viewer.authz.can("campaign.budget:manage");
  const ready = providerReady(provider);
  const pill = HEALTH_PILL[connection.health];
  const editing = mayManage && (connection.status === "PENDING" || q.edit === "1");
  const active = connection.accounts.filter((a) => a.active);
  const adAccounts = active.filter((a) => AD_KINDS.includes(a.kind));
  const kinds = ACCOUNT_KINDS.filter((k) => k.provider === provider);
  const heldBy = new Map(connection.accounts.map((a) => [`${a.kind}|${a.externalId}`, a]));
  const root = places.find((p) => p.kind === "ORG");
  const metaAds = adAccounts.filter((a) => a.kind === "META_AD_ACCOUNT");
  const bidding = await biddingStates(orgId, metaAds.map((a) => a.id));

  // A login that reaches nothing can only be swapped for another or dropped,
  // so neither Save nor Change accounts is offered for it.
  const nothingOffered = connection.choices.length === 0;
  const reconnect = ready ? (
    <a
      href={`/api/connect/${slug}/start`}
      className={`btn ${nothingOffered ? "btn--ink" : "btn--ghost"}`}
      data-reconnect={slug}
    >
      {nothingOffered ? `Reconnect with another login` : "Reconnect"}
      {nothingOffered && <ArrowUpRight size={14} />}
    </a>
  ) : null;
  const disconnectButton = (
    <ConfirmAction
      label="Disconnect"
      title={`Disconnect ${def.label}?`}
      body={
        <p>
          {adAccounts.length > 0 && "Any ad that is spending is paused first. "}
          Nothing more goes to {active.map((a) => a.name).join(", ") || def.label}, and posts already out stay where
          they are. You can connect again at any time.
        </p>
      }
      confirmLabel={`Disconnect ${def.label}`}
      action={disconnectAction}
      fields={{ provider }}
      tone="risk"
      size="md"
      testId="disconnect"
    />
  );

  const meta = [
    connection.connectedByName ? `Connected by ${connection.connectedByName}` : "Connected",
    on(connection.connectedAt) ? `on ${on(connection.connectedAt)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  // Spend controls exist only for ad accounts, and only read-only.
  const spend = adAccounts.length > 0 && !editing;
  const limitsCard = (
        <section className="card">
          <div className="card__head">
            <h2>Daily limits</h2>
          </div>
          <ul className="acct-list">
            {adAccounts.map((a) => (
              <li key={a.id} className="acct acct--limit" data-limit={a.externalId}>
                <span className="acct__id">
                  <strong>{a.name}</strong>
                  <small>{a.dailyCap === null ? "No ad is created until a limit is set" : `Up to ${showRupees(a.dailyCap)} a day, per ad`}</small>
                </span>
                {mayBudget ? (
                  <KeptForm action={setDailyCapAction} className="acct__capform" messageAt="bottom">
                    <input type="hidden" name="provider" value={provider} />
                    <input type="hidden" name="accountId" value={a.id} />
                    <span className="mv-money">
                      <span aria-hidden="true">Rs</span>
                      <input
                        name="dailyCap"
                        inputMode="numeric"
                        defaultValue={a.dailyCap ?? ""}
                        placeholder="5,000"
                        className="mv-input"
                        aria-label={`Daily limit for ${a.name}, in rupees`}
                      />
                    </span>
                    <button type="submit" className="btn btn--ghost btn--sm">
                      Save limit
                    </button>
                  </KeptForm>
                ) : (
                  <span className={`pill ${a.dailyCap === null ? "pill--warn" : "pill--quiet"}`}>
                    {a.dailyCap === null ? "Not set" : `${showRupees(a.dailyCap)} a day`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
  );
  const moveCard = (
        <section className="card" aria-labelledby="auto-budget-title">
          <div className="card__head">
            <h2 id="auto-budget-title">Move budget to the ads that bring buyers</h2>
          </div>
          <ul className="acct-list">
            {adAccounts.map((a) => (
              <li key={a.id} className="acct acct--limit" data-auto-budget={a.externalId}>
                <span className="acct__id">
                  <strong>{a.name}</strong>
                  <small>
                    {a.autoBudget
                      ? "Once a day. The total stays the same, within the daily limit."
                      : "Each ad keeps the budget it was given."}
                  </small>
                </span>
                {mayBudget ? (
                  <BudgetSwitch accountId={a.id} on={a.autoBudget} name={a.name} />
                ) : (
                  <span className={`pill ${a.autoBudget ? "pill--ok" : "pill--quiet"}`}>
                    <span className="pill__dot" />
                    {a.autoBudget ? "On" : "Off"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
  );
  const bidCard = (
        <section className="card" aria-labelledby="qualified-bid-title">
          <div className="card__head">
            <h2 id="qualified-bid-title">Bid on qualified buyers</h2>
          </div>
          <ul className="acct-list">
            {metaAds.map((a) => {
              const b = bidding.get(a.id) ?? { on: false, leads: 0, ready: false, needed: QUALIFIED_BID_LEADS };
              return (
                <li key={a.id} className="acct acct--limit" data-qualified-bidding={a.externalId}>
                  <span className="acct__id">
                    <strong>{a.name}</strong>
                    <small className="tnum">
                      {b.on
                        ? "New ads look for buyers like the ones your team qualified."
                        : b.ready
                          ? `${b.leads.toLocaleString("en-IN")} leads in the last 30 days. New ads look for clicks.`
                          : `${b.needed.toLocaleString("en-IN")} more leads in the last 30 days to switch this on.`}
                    </small>
                  </span>
                  {b.on ? (
                    mayBudget ? (
                      <ConfirmAction
                        label="Optimise for clicks again"
                        title={`Optimise ${a.name} for clicks again?`}
                        body="New ads from this account will look for clicks. Ads already running keep what they had."
                        confirmLabel="Optimise for clicks"
                        action={setQualifiedBiddingAction}
                        fields={{ accountId: a.id, on: "false" }}
                        tone="ghost"
                      />
                    ) : (
                      <span className="pill pill--ok">
                        <span className="pill__dot" />
                        On
                      </span>
                    )
                  ) : mayBudget && b.ready ? (
                    <ConfirmAction
                      label="Optimise for qualified buyers"
                      title={`Optimise ${a.name} for qualified buyers?`}
                      body="New ads from this account will look for buyers like the ones your team marked Qualified, not for clicks. Ads already running keep what they had."
                      confirmLabel="Optimise for qualified buyers"
                      action={setQualifiedBiddingAction}
                      fields={{ accountId: a.id, on: "true" }}
                    />
                  ) : mayBudget ? (
                    <button type="button" className="btn btn--ghost btn--sm" disabled aria-disabled="true">
                      Optimise for qualified buyers
                    </button>
                  ) : (
                    <span className="pill pill--quiet">Off</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
  );
  const connectionCard = (
        <section className="card">
          <div className="card__head">
            <h2>The connection</h2>
          </div>
          <div className="facts prov-facts">
            <div className="fact">
              <div className="fact__k">Connected by</div>
              <div className="fact__v">{connection.connectedByName ?? "Somebody who has left"}</div>
            </div>
            <div className="fact">
              <div className="fact__k">Last checked</div>
              <div className="fact__v">{on(connection.lastCheckedAt) ?? "Not yet"}</div>
            </div>
            <div className="fact">
              <div className="fact__k">Access runs out</div>
              <div className="fact__v">{connection.tokenExpiresAt ? on(connection.tokenExpiresAt) : "Does not run out"}</div>
            </div>
          </div>
          {mayManage && (
            <div className="conn__controls">
              <form action={checkConnectionAction}>
                <input type="hidden" name="provider" value={provider} />
                <button type="submit" className="btn btn--ghost btn--sm" data-check>
                  Check it now
                </button>
              </form>
            </div>
          )}
        </section>
  );

  return (
    <>
      <PageHead
        title={
          <>
            <span className="conn__titlemark">
              <ProviderMark provider={provider} size={22} />
            </span>
            {def.label} <span className="em">accounts</span>
          </>
        }
        meta={meta}
        back={{ label: "Connected accounts", href: "/dashboard/settings/connections" }}
        action={
          editing && connection.status !== "PENDING" ? (
            <>
              <Link href={`/dashboard/settings/connections/${slug}`} className="btn btn--ghost">
                Cancel
              </Link>
              <button type="submit" form={FORM} className="btn btn--ink" data-save-accounts>
                Save accounts
                <Check size={14} />
              </button>
            </>
          ) : mayManage ? (
            // A first consent opens straight onto the choice; it can still be
            // dropped or done again with another login.
            <>
              {disconnectButton}
              {reconnect}
              {!nothingOffered &&
                (editing ? (
                  <button type="submit" form={FORM} className="btn btn--ink" data-save-accounts>
                    Save accounts
                    <Check size={14} />
                  </button>
                ) : (
                  <Link
                    href={`/dashboard/settings/connections/${slug}?edit=1`}
                    className="btn btn--ink"
                    data-change-accounts
                  >
                    Change accounts
                    <ArrowUpRight size={14} />
                  </Link>
                ))}
            </>
          ) : null
        }
      />

      <Flash text={error} name="error" />
      {/* A fixed sentence, so the bare flag is enough: nothing in it is taken
          from the address. */}
      <Flash
        text={
          q.connected === "1"
            ? connection.status === "PENDING"
              ? `${def.label} is connected. Choose the accounts posts go to.`
              : `${def.label} is reconnected.`
            : null
        }
        name="connected"
        tone="info"
      />
      <Flash text={note} name="note" tone="info" />
      <Flash text={done} name="done" tone="info" />
      {(connection.health === "broken" || connection.health === "expired") && (
        <div className="note note--risk" role="alert">
          <strong>{def.label} stopped working</strong>
          {connection.lastError ?? "Posts and ads going here fail until it is reconnected."}
        </div>
      )}
      {connection.health === "expiring" && connection.tokenExpiresAt && (
        <div className="note note--warn">
          <strong>Reconnect by {on(connection.tokenExpiresAt)}</strong>
          After that, posts and ads going to {def.label} stop until somebody reconnects.
        </div>
      )}

      {editing ? (
        // A refusal is shown on the card and every tick and place survives it.
        <KeptForm id={FORM} action={chooseAccountsAction} className="card">
          <input type="hidden" name="provider" value={provider} />
          <div className="card__head">
            <h2>Where posts go</h2>
            <span className="pill pill--quiet">{connection.choices.length} offered</span>
          </div>
          {connection.choices.length === 0 ? (
            <p className="formfield__unset">
              This {def.label} login reaches no accounts. Reconnect with a login that manages them, or disconnect.
            </p>
          ) : (
            kinds.map((k) => {
              const offered = connection.choices.filter((c) => c.kind === k.key);
              if (!offered.length) return null;
              return (
                <fieldset key={k.key} className="acct-group">
                  <legend>{k.label}s</legend>
                  {offered.map((c) => {
                    const held = heldBy.get(`${c.kind}|${c.id}`);
                    const id = `${c.kind}|${c.id}`;
                    const line = describe(c);
                    return (
                      <div key={id} className="acct">
                        <label className="acct__pick">
                          <input type="checkbox" name="pick" value={id} defaultChecked={!!held?.active} data-pick={id} />
                          <span className="acct__id">
                            <strong>{c.name}</strong>
                            {line && <small>{line}</small>}
                          </span>
                          {c.detail.status && c.detail.status !== "Active" && (
                            <span className="pill pill--warn">{c.detail.status}</span>
                          )}
                        </label>
                        <label className="acct__where">
                          <span className="sr-only">Used for</span>
                          <select
                            name={`node:${id}`}
                            defaultValue={held?.nodeId ?? root?.id}
                            className="select-field"
                            aria-label={`Where ${c.name} is used`}
                          >
                            {places.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.kind === "ORG" ? "Whole organisation" : p.kind === "ENTITY" ? `${p.name} (entity)` : p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    );
                  })}
                </fieldset>
              );
            })
          )}
        </KeptForm>
      ) : (
        // Read-only: short cards two across, so no card is one line on the
        // left of a full-width bar.
        <div className="stack prov">
          <div className="pair pair--stretch">
            <section className="card">
              <div className="card__head">
                <h2>Where posts go</h2>
                <span className={`pill pill--${pill.tone}`}>
                  <span className="pill__dot" />
                  {pill.text}
                </span>
              </div>
              {active.length === 0 ? (
                <p className="formfield__unset">Nothing chosen, so nothing goes to {def.label}.</p>
              ) : (
                <ul className="acct-list">
                  {active.map((a) => {
                    const leads = leadFormsLine(a);
                    return (
                      <li key={a.id} className="acct acct--read">
                        <span className="acct__kind">{accountKindLabel(a.kind)}</span>
                        <span className="acct__id">
                          <strong>{a.name}</strong>
                          {describe(a) && <small>{describe(a)}</small>}
                          {leads && (
                            <small className={`acct__leads acct__leads--${leads.tone}`} data-lead-forms={leads.tone}>
                              {leads.text}
                            </small>
                          )}
                        </span>
                        <span className="pill pill--quiet">{a.nodeKind === "ORG" ? "Whole organisation" : a.nodeName}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            {spend ? limitsCard : connectionCard}
          </div>
          {spend && (
            <div className="pair pair--stretch">
              {moveCard}
              {metaAds.length > 0 ? bidCard : connectionCard}
            </div>
          )}
          {spend && metaAds.length > 0 && connectionCard}
        </div>
      )}
    </>
  );
}
