import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { crmHealth, leadFieldChoices, loadMappings, mappingTargets, projectFieldChoices, type CrmHealth, type MappingView } from "@/lib/crm-sync";
import { CRM_PROVIDERS, crmCapabilities, crmFromSlug, crmLabel, crmSlug, type CrmProvider, type LsqFieldChoice } from "@/lib/crm-rules";
import type { StageKey } from "@/lib/lead-rules";
import {
  connectCrmAction,
  disconnectCrmAction,
  retryDeadAction,
  saveMatchesAction,
  saveTowerKeysAction,
  setProjectFieldAction,
  syncNowAction,
} from "@/app/actions/crm";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { ArrowUpRight, Board, Check } from "@/components/icons";
import { StageMatches } from "./StageMatches";
import "./crm.css";

/**
 * The developer's CRM beside us: connect it, match its words to ours, and
 * see what is stuck.
 *
 * It opens on the work: the one dark card holds what needs a person (a key
 * that stopped working, writes it refused for good, words nobody matched).
 * The matches below it open read-only, because they are live: changing one
 * moves leads. "Change matches" is the decision.
 */

const MATCH_FORM = "crmmatches";
const CONNECT_FORM = "crmconnect";

const when = (d: Date | null) =>
  d
    ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })
    : null;

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

export default async function CrmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("integration:manage")) redirect("/dashboard/settings/connections");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const error = readFlash(q, "error");
  const done = readFlash(q, "done");

  const health = await crmHealth(orgId);
  if (!health || q.reconnect === "1") {
    const chosen = health?.provider ?? crmFromSlug(typeof q.crm === "string" ? q.crm : null) ?? "LEADSQUARED";
    return <ConnectView provider={chosen} reconnect={!!health} error={error} />;
  }

  const editing = q.edit === "1";
  const [maps, targets, fields, leadFields] = await Promise.all([
    loadMappings(orgId, health.connectionId),
    mappingTargets(orgId),
    health.provider === "LEADSQUARED" && !health.projectField ? projectFieldChoices(orgId) : Promise.resolve(null),
    // Asked of LeadSquared only when a person is choosing them.
    health.provider === "LEADSQUARED" && editing ? leadFieldChoices(orgId) : Promise.resolve(null),
  ]);
  const label = crmLabel(health.provider);
  const twoWay = health.provider !== "SELLDO";

  return (
    <>
      <PageHead
        title={
          <>
            <span className="conn__titlemark crm-mark">
              <Board size={18} />
            </span>
            {label} <span className="em">sync</span>
          </>
        }
        meta={[
          health.connectedByName ? `Connected by ${health.connectedByName}` : "Connected",
          `on ${when(health.connectedAt)}`,
          health.lastSyncedAt ? `· last synced ${when(health.lastSyncedAt)}` : null,
        ]
          .filter(Boolean)
          .join(" ")}
        back={{ label: "Connected accounts", href: "/dashboard/settings/connections" }}
        action={
          editing ? (
            <>
              <Link href="/dashboard/settings/connections/crm" className="btn btn--ghost">
                Cancel
              </Link>
              <button type="submit" form={MATCH_FORM} className="btn btn--ink" data-save-matches>
                {twoWay ? "Save matches" : "Save campaign keys"}
                <Check size={14} />
              </button>
            </>
          ) : health.status === "BROKEN" ? (
            <Link href="/dashboard/settings/connections/crm?reconnect=1" className="btn btn--ink">
              Enter the keys again
              <ArrowUpRight size={14} />
            </Link>
          ) : (
            <>
              <form action={syncNowAction}>
                <button type="submit" className="btn btn--ghost" data-sync-now>
                  Sync now
                </button>
              </form>
              <Link href="/dashboard/settings/connections/crm?edit=1" className="btn btn--ink" data-change-matches>
                {twoWay ? "Change matches" : "Change campaign keys"}
                <ArrowUpRight size={14} />
              </Link>
            </>
          )
        }
      />

      <Flash text={error} name="error" />
      <Flash text={done} name="done" tone="info" />
      {!twoWay && (
        <div className="note note--info">
          <strong>New leads only</strong>
          Every new lead goes to Sell.Do under its tower&apos;s campaign. Moves made in Sell.Do do not come back here.
        </div>
      )}

      {!editing && <NeedsYou health={health} label={label} fields={fields} />}

      {twoWay ? (
        <Matches maps={maps} targets={targets} editing={editing} label={label} health={health} leadFields={leadFields} />
      ) : (
        <TowerKeys maps={maps} towers={targets.towers} editing={editing} />
      )}

      {!editing && (
        <SyncCard
          health={health}
          label={label}
          twoWay={twoWay}
          towers={targets.towers.map((t) => ({
            name: towerName(t),
            ...sellDoWords(twoWay, crmCapabilities({
              connected: health.status === "CONNECTED",
              broken: health.status === "BROKEN",
              towerMapped: maps.some((m) => m.kind === "PROJECT" && m.nodeId === t.id),
              stagesWithoutPush: twoWay ? health.stagesWithoutPush.length : 0,
            })),
          }))}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ConnectView({ provider, reconnect, error }: { provider: CrmProvider; reconnect: boolean; error: string | null }) {
  const label = crmLabel(provider);
  return (
    <>
      <PageHead
        title={
          reconnect ? (
            <>
              Reconnect <span className="em">{label}</span>
            </>
          ) : (
            <>
              Connect your <span className="em">CRM</span>
            </>
          )
        }
        meta={reconnect ? "Paste the keys again. Your matches stay as they are." : "New leads go to it as they arrive."}
        back={{ label: reconnect ? `${label} sync` : "Connected accounts", href: reconnect ? "/dashboard/settings/connections/crm" : "/dashboard/settings/connections" }}
        action={
          <button type="submit" form={CONNECT_FORM} className="btn btn--ink" data-connect-crm={crmSlug(provider)}>
            Connect {label}
            <ArrowUpRight size={14} />
          </button>
        }
      />
      <Flash text={error} name="error" />

      {!reconnect && (
        <nav className="crm-pick" aria-label="Your CRM">
          {CRM_PROVIDERS.map((p) => (
            <Link
              key={p.key}
              href={`/dashboard/settings/connections/crm?crm=${crmSlug(p.key)}`}
              className={`crm-pick__tile${p.key === provider ? " crm-pick__tile--on" : ""}`}
              aria-current={p.key === provider ? "true" : undefined}
              data-pick-crm={crmSlug(p.key)}
            >
              <strong>{p.label}</strong>
              <span>{p.twoWay ? "Leads both ways" : "New leads only"}</span>
            </Link>
          ))}
        </nav>
      )}

      <KeptForm id={CONNECT_FORM} action={connectCrmAction} className="card crm-card">
        <input type="hidden" name="provider" value={provider} />
        <div className="card__head">
          <h2>{label} keys</h2>
        </div>
        <p className="crm-where">{WHERE[provider]}</p>
        <div className="crm-fields">
          {provider === "LEADRAT" && <Field name="tenant" label="Account" placeholder="acme, as in acme.leadrat.com" />}
          {provider === "LEADSQUARED" && <Field name="accessKey" label="Access key" placeholder="u$r..." secret />}
          {provider !== "LEADSQUARED" && <Field name="apiKey" label="API key" placeholder="Paste the key" secret />}
          {provider !== "SELLDO" && <Field name="secretKey" label="Secret key" placeholder="Paste the secret" secret />}
        </div>
      </KeptForm>
    </>
  );
}

const WHERE: Record<CrmProvider, string> = {
  LEADSQUARED: "In LeadSquared: My Account, Settings, API and Webhooks. Use an admin's keys.",
  SELLDO: "In Sell.Do: Marketing Automation, Lead Integrations, API Based Integrations, New API Integration.",
  LEADRAT: "In LeadRat: Global Settings, Developer Resources.",
};

function Field({ name, label, placeholder, secret }: { name: string; label: string; placeholder: string; secret?: boolean }) {
  return (
    <label className="formfield" htmlFor={`crm-${name}`}>
      <span className="formfield__label">{label}</span>
      <input
        id={`crm-${name}`}
        name={name}
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        required
        placeholder={placeholder}
        className="formfield__input"
      />
    </label>
  );
}

// ---------------------------------------------------------------------------

/** The one dark card: what a person has to do before leads flow cleanly. */
function NeedsYou({ health, label, fields }: { health: CrmHealth; label: string; fields: { schemaName: string; label: string }[] | null }) {
  const w = health.waitingMappings;
  const unmatched = [
    w.STAGE ? count(w.STAGE, "status", "statuses") : null,
    w.PROJECT ? count(w.PROJECT, "project") : null,
    w.USER ? count(w.USER, "person", "people") : null,
  ].filter(Boolean) as string[];
  const unset = health.provider === "SELLDO" ? [] : health.stagesWithoutPush;
  const needsField = health.provider === "LEADSQUARED" && !health.projectField;
  const items = (health.status === "BROKEN" ? 1 : 0) + (needsField ? 1 : 0) + (unmatched.length ? 1 : 0) + (unset.length ? 1 : 0) + (health.dead.length ? 1 : 0);
  if (!items) return null;

  return (
    <section className="conn conn--needs crm-needs" aria-labelledby="crm-needs-h" data-crm-needs>
      <header className="conn__head">
        <div className="conn__id">
          <h2 id="crm-needs-h">Needs you</h2>
          <p>{count(items, "thing")} before leads flow cleanly.</p>
        </div>
      </header>
      <ul className="crm-needs__list">
        {health.status === "BROKEN" && (
          <li>
            <span className="crm-needs__what">
              <strong>{label} stopped accepting the keys</strong>
              <span>{health.lastError ?? "Nothing goes to it or comes from it until they are entered again."}</span>
            </span>
            <Link href="/dashboard/settings/connections/crm?reconnect=1" className="btn btn--light btn--sm">
              Enter the keys again
            </Link>
          </li>
        )}
        {needsField && (
          <li>
            <span className="crm-needs__what">
              <strong>Which LeadSquared field holds the project?</strong>
              <span>Leads are placed in a tower by it.</span>
            </span>
            {fields && fields.length ? (
              <KeptForm action={setProjectFieldAction} className="crm-needs__form" messageAt="bottom">
                <label>
                  <span className="sr-only">Field that holds the project</span>
                  <select name="field" className="select-field" defaultValue="" required>
                    <option value="" disabled>
                      Choose a field
                    </option>
                    {fields.map((f) => (
                      <option key={f.schemaName} value={f.schemaName}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn--light btn--sm">
                  Save
                </button>
              </KeptForm>
            ) : (
              <span className="crm-needs__aside">LeadSquared lists no dropdown field yet. Add one there, then refresh.</span>
            )}
          </li>
        )}
        {unmatched.length > 0 && (
          <li>
            <span className="crm-needs__what">
              <strong>{unmatched.join(", ")} not matched yet</strong>
              <span>
                {health.eventsWaiting
                  ? `${count(health.eventsWaiting, "change")} from ${label} ${health.eventsWaiting === 1 ? "waits" : "wait"} on these.`
                  : "Leads on them wait here until they are."}
              </span>
            </span>
            <Link href="/dashboard/settings/connections/crm?edit=1" className="btn btn--light btn--sm">
              Match them
            </Link>
          </li>
        )}
        {unset.length > 0 && (
          <li>
            <span className="crm-needs__what">
              <strong>
                Choose what to set in {label} for {count(unset.length, "stage")}
              </strong>
              <span>{health.writesWaiting ? `${count(health.writesWaiting, "lead")} ${health.writesWaiting === 1 ? "waits" : "wait"} to go.` : "A lead moved to one of them waits until you do."}</span>
            </span>
            <Link href="/dashboard/settings/connections/crm?edit=1#crm-push" className="btn btn--light btn--sm">
              Choose
            </Link>
          </li>
        )}
        {health.dead.length > 0 && (
          <li className="crm-needs__dead">
            <span className="crm-needs__what">
              <strong>
                {count(health.dead.length, "lead")} {label} refused
              </strong>
              <span>Fix what it names, then try again.</span>
            </span>
            {health.dead.length > 1 && (
              <form action={retryDeadAction}>
                <input type="hidden" name="id" value="all" />
                <button type="submit" className="btn btn--light btn--sm" data-retry-all>
                  Try all again
                </button>
              </form>
            )}
            <ul className="crm-dead">
              {health.dead.map((d) => (
                <li key={d.id} data-dead={d.leadId}>
                  <Link href={`/dashboard/leads/${d.leadId}`} className="crm-dead__lead">
                    {d.leadName}
                  </Link>
                  <span className="crm-dead__why">{d.error ?? `${label} refused it.`}</span>
                  <form action={retryDeadAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" className="crm-dead__retry">
                      Try again
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

function towerName(t: { name: string; project: string | null }) {
  return t.project ? `${t.project}, ${t.name}` : t.name;
}

function Matches({
  maps,
  targets,
  editing,
  label,
  health,
  leadFields,
}: {
  maps: MappingView[];
  targets: { towers: { id: string; name: string; project: string | null }[]; people: { id: string; name: string }[] };
  editing: boolean;
  label: string;
  health: CrmHealth;
  leadFields: LsqFieldChoice[] | null;
}) {
  const stages = maps.filter((m) => m.kind === "STAGE");
  const projects = maps.filter((m) => m.kind === "PROJECT");
  const people = maps.filter((m) => m.kind === "USER");
  const push = Object.fromEntries(stages.filter((m) => m.pushAs && m.stage).map((m) => [m.stage, m.id])) as Partial<Record<StageKey, string>>;
  const towerOf = new Map(targets.towers.map((t) => [t.id, t]));
  const personOf = new Map(targets.people.map((p) => [p.id, p.name]));
  const byProject = new Map<string, typeof targets.towers>();
  for (const t of targets.towers) {
    const k = t.project ?? "Other towers";
    byProject.set(k, [...(byProject.get(k) ?? []), t]);
  }

  const body = (
    <>
      <StageMatches
        rows={stages.map((m) => ({ id: m.id, label: m.label, parentId: m.parentId, parentLabel: m.parentLabel, externalId: m.externalId, stage: m.stage }))}
        push={push}
        editing={editing}
        crm={label}
      />

      <section className="card crm-card" aria-labelledby="crm-projects">
        <div className="card__head">
          <h2 id="crm-projects">Projects</h2>
          <span className="pill pill--quiet">{projects.length} in {label}</span>
        </div>
        {projects.length === 0 ? (
          <p className="formfield__unset">
            {health.provider === "LEADSQUARED" && !health.projectField ? "Choose the field that holds the project first." : `${label} listed no projects yet.`}
          </p>
        ) : (
          <ul className="acct-list">
            {projects.map((m) => {
              const t = m.nodeId ? towerOf.get(m.nodeId) : undefined;
              return (
                <li key={m.id} className={`acct ${editing ? "" : "acct--read "}crm-row`} data-project-row={m.label}>
                  <span className="acct__id">
                    <strong>{m.label}</strong>
                    {!m.lastSeenAt && <small>No longer listed in {label}</small>}
                  </span>
                  {editing ? (
                    <label className="acct__where">
                      <span className="sr-only">Tower for {m.label}</span>
                      <select name={`m:${m.id}`} className="select-field" defaultValue={m.nodeId ? `node:${m.nodeId}` : m.ignored ? "ignore" : ""}>
                        <option value="">Not matched</option>
                        <option value="ignore">Not ours</option>
                        {[...byProject.entries()].map(([project, towers]) => (
                          <optgroup key={project} label={project}>
                            {towers.map((tw) => (
                              <option key={tw.id} value={`node:${tw.id}`}>
                                {tw.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                  ) : t ? (
                    <span className="pill pill--quiet">{towerName(t)}</span>
                  ) : m.ignored ? (
                    <span className="pill pill--quiet">Not ours</span>
                  ) : (
                    <span className="pill pill--warn">Not matched</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {health.provider === "LEADSQUARED" && (
        <LeadFields health={health} label={label} editing={editing} choices={leadFields} />
      )}

      <section className="card crm-card" aria-labelledby="crm-people">
        <div className="card__head">
          <h2 id="crm-people">People</h2>
          <span className="pill pill--quiet">{people.length} in {label}</span>
        </div>
        {people.length === 0 ? (
          <p className="formfield__unset">{label} listed no users yet.</p>
        ) : (
          <ul className="acct-list">
            {people.map((m) => (
              <li key={m.id} className={`acct ${editing ? "" : "acct--read "}crm-row`} data-person-row={m.label}>
                <span className="acct__id">
                  <strong>{m.label}</strong>
                </span>
                {editing ? (
                  <label className="acct__where">
                    <span className="sr-only">Person here for {m.label}</span>
                    <select name={`m:${m.id}`} className="select-field" defaultValue={m.userId ? `user:${m.userId}` : m.ignored ? "ignore" : ""}>
                      <option value="">Not matched</option>
                      <option value="ignore">Nobody here</option>
                      {targets.people.map((p) => (
                        <option key={p.id} value={`user:${p.id}`}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : m.userId ? (
                  <span className="pill pill--quiet">{personOf.get(m.userId) ?? "Somebody who has left"}</span>
                ) : m.ignored ? (
                  <span className="pill pill--quiet">Nobody here</span>
                ) : (
                  <span className="pill pill--warn">Not matched</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );

  return editing ? (
    <KeptForm id={MATCH_FORM} action={saveMatchesAction} className="crm-matches">
      {body}
    </KeptForm>
  ) : (
    <div className="crm-matches">{body}</div>
  );
}

/** Which of LeadSquared's own fields hold configuration and budget. */
function LeadFields({ health, label, editing, choices }: { health: CrmHealth; label: string; editing: boolean; choices: LsqFieldChoice[] | null }) {
  const rows: { key: "config" | "budget"; name: string; chosen: { label: string; schemaName: string } | null }[] = [
    { key: "config", name: "Configuration", chosen: health.leadFields.config },
    { key: "budget", name: "Budget", chosen: health.leadFields.budget },
  ];
  const set = rows.filter((r) => r.chosen).length;
  return (
    <section className="card crm-card" aria-labelledby="crm-leadfields">
      <div className="card__head">
        <h2 id="crm-leadfields">Lead fields</h2>
        <span className="pill pill--quiet">{set} of 2 chosen</span>
      </div>
      <ul className="acct-list">
        {rows.map((r) => (
          <li key={r.key} className={`acct ${editing ? "" : "acct--read "}crm-row`} data-lead-field={r.key}>
            <span className="acct__id">
              <strong>{r.name}</strong>
            </span>
            {editing ? (
              <label className="acct__where">
                <span className="sr-only">
                  {label} field that holds {r.name.toLowerCase()}
                </span>
                <select
                  name={`lf:${r.key}`}
                  className="select-field"
                  defaultValue={r.chosen?.schemaName ?? ""}
                >
                  <option value="">Not synced</option>
                  {(choices ?? []).map((c) => (
                    <option key={c.schemaName} value={c.schemaName}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : r.chosen ? (
              <span className="pill pill--quiet">{r.chosen.label}</span>
            ) : (
              <span className="pill pill--quiet">Not synced</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TowerKeys({ maps, towers, editing }: { maps: MappingView[]; towers: { id: string; name: string; project: string | null }[]; editing: boolean }) {
  const keyOf = new Map(maps.filter((m) => m.kind === "PROJECT" && m.nodeId).map((m) => [m.nodeId!, m.externalId]));
  const rows = (
    <section className="card crm-card" aria-labelledby="crm-towers">
      <div className="card__head">
        <h2 id="crm-towers">Campaign for each tower</h2>
        <span className="pill pill--quiet">{keyOf.size} of {towers.length} set</span>
      </div>
      {editing && <p className="crm-where">In Sell.Do: open the campaign, then Input Channels. Copy the 24-character key (SRD).</p>}
      {towers.length === 0 ? (
        <p className="formfield__unset">No towers yet.</p>
      ) : (
        <ul className="acct-list">
          {towers.map((t) => {
            const key = keyOf.get(t.id);
            return (
              <li key={t.id} className={`acct ${editing ? "" : "acct--read "}crm-row`} data-tower-key={t.name}>
                <span className="acct__id">
                  <strong>{t.name}</strong>
                  {t.project && <small>{t.project}</small>}
                </span>
                {editing ? (
                  <label className="acct__where">
                    <span className="sr-only">Sell.Do campaign key for {t.name}</span>
                    <input name={`srd:${t.id}`} defaultValue={key ?? ""} placeholder="24 letters and numbers" className="mv-input crm-key" spellCheck={false} autoComplete="off" />
                  </label>
                ) : key ? (
                  <span className="pill pill--quiet crm-keyval">{key}</span>
                ) : (
                  <span className="pill pill--warn">Not set</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
  return editing ? (
    <KeptForm id={MATCH_FORM} action={saveTowerKeysAction} className="crm-matches">
      {rows}
    </KeptForm>
  ) : (
    <div className="crm-matches">{rows}</div>
  );
}

/** Sell.Do has campaigns where the others have projects, and takes nothing back. */
function sellDoWords<T extends { read: { state: string; reason: string }; write: { state: string; reason: string } }>(twoWay: boolean, c: T): T {
  if (twoWay) return c;
  const unset = { state: "todo", reason: "Set its Sell.Do campaign key." };
  return { ...c, read: { state: "off", reason: "Sell.Do sends nothing back." }, write: c.write.state === "ready" ? { state: "ready", reason: "New leads go to Sell.Do." } : c.write.state === "off" ? c.write : unset };
}

function SyncCard({
  health,
  label,
  twoWay,
  towers,
}: {
  health: CrmHealth;
  label: string;
  twoWay: boolean;
  towers: { name: string; read: { state: string; reason: string }; write: { state: string; reason: string } }[];
}) {
  const writing = towers.filter((t) => t.write.state === "ready").length;
  const off = towers.filter((t) => t.write.state !== "ready");
  return (
    <section className="card crm-card" aria-labelledby="crm-sync">
      <div className="card__head">
        <h2 id="crm-sync">The connection</h2>
        <span className={`pill pill--${health.status === "BROKEN" ? "risk" : "ok"}`}>
          <span className="pill__dot" />
          {health.status === "BROKEN" ? "Stopped working" : "Working"}
        </span>
      </div>
      <div className="facts">
        <div className="fact">
          <div className="fact__k">Leads matched</div>
          <div className="fact__v">{health.linked.toLocaleString("en-IN")}</div>
        </div>
        <div className="fact">
          <div className="fact__k">Waiting to go</div>
          <div className="fact__v">{health.writesQueued.toLocaleString("en-IN")}</div>
        </div>
        <div className="fact">
          <div className="fact__k">Waiting on a match</div>
          <div className="fact__v">{(health.writesWaiting + health.eventsWaiting).toLocaleString("en-IN")}</div>
        </div>
        <div className="fact">
          <div className="fact__k">Changes from {label}</div>
          <div className="fact__v">{!twoWay ? "Not available" : health.hooks ? "As they happen" : "Every 5 minutes"}</div>
        </div>
        <div className="fact">
          <div className="fact__k">Towers syncing</div>
          <div className="fact__v">
            {writing.toLocaleString("en-IN")} of {towers.length.toLocaleString("en-IN")}
          </div>
        </div>
        {health.account && (
          <div className="fact">
            <div className="fact__k">Account</div>
            <div className="fact__v">{health.account}</div>
          </div>
        )}
      </div>
      {off.length > 0 && health.status === "CONNECTED" && (
        <ul className="crm-towers">
          {off.map((t) => (
            <li key={t.name}>
              <strong>{t.name}</strong>
              <span>{t.write.reason}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="conn__controls">
        <ConfirmAction
          label={`Disconnect ${label}`}
          title={`Disconnect ${label}?`}
          body={<p>Nothing more goes to {label}, and anything waiting to go is dropped. Leads already there stay there, and your matches are kept for a reconnect.</p>}
          confirmLabel={`Disconnect ${label}`}
          action={disconnectCrmAction}
          fields={{}}
          tone="risk"
          testId="disconnect-crm"
        />
      </div>
    </section>
  );
}
