import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { availabilityOf, exampleSheet, STATUS_LABEL, type UnitStatus } from "@/lib/inventory-rules";
import { listUnits, readableTowers } from "@/lib/inventory";
import { configLabel } from "@/lib/unit-rules";
import { importAvailabilityAction, saveFeedAction } from "@/app/actions/inventory";
import { feedFor, projectOfTower, type FeedView } from "@/lib/inventory-feed";
import { PageHead } from "@/components/shell/PageHead";
import { SubTabs } from "@/components/shell/SubTabs";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { Board, Building, Phone } from "@/components/icons";
import "./availability.css";

/**
 * Which flats a tower still has. A sales person reads it mid-call; whoever
 * owns the tower's sheet updates it. It is never on an advertisement, and
 * nothing here offers to put it on one.
 */

const TONE: Record<UnitStatus, string> = { AVAILABLE: "ok", BLOCKED: "warn", BOOKED: "quiet" };
const FILTERS: { key: UnitStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "AVAILABLE", label: "Available" },
  { key: "BLOCKED", label: "Blocked" },
  { key: "BOOKED", label: "Booked" },
];
const FACING: Record<string, string> = { N: "North", NE: "North-east", E: "East", SE: "South-east", S: "South", SW: "South-west", W: "West", NW: "North-west" };

const when = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : null;

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("inventory:read")) redirect("/dashboard/leads");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const error = readFlash(q, "error");
  const done = readFlash(q, "done");

  const towers = await readableTowers(orgId, viewer.authz.scopesFor("inventory:read"));
  const tower = towers.find((t) => t.id === q.tower) ?? towers.find((t) => t.flats > 0) ?? towers[0] ?? null;
  const [units, feed, project] = tower
    ? await Promise.all([listUnits(orgId, tower.id), feedFor(orgId, tower.id), projectOfTower(orgId, tower.id)])
    : [[], null, null];
  const filter = FILTERS.find((f) => f.key === q.status)?.key ?? "ALL";
  const shown = filter === "ALL" ? units : units.filter((u) => u.status === filter);
  const byConfig = availabilityOf(units);
  const mayImport = !!tower && viewer.authz.canAt("inventory:manage", tower.path);
  const mayProject = !!project && viewer.authz.canAt("inventory:manage", project.path);
  // A project's sheet is changed only by somebody who holds the key there.
  const mayFeed = mayImport && (feed?.kind !== "PROJECT" || mayProject);
  const available = units.filter((u) => u.status === "AVAILABLE").length;
  const hrefFor = (params: Record<string, string>) => `/dashboard/leads/availability?${new URLSearchParams({ ...(tower ? { tower: tower.id } : {}), ...params })}`;

  const tabs = (
    <SubTabs
      label="Leads views"
      current="/dashboard/leads/availability"
      items={[
        ...(viewer.authz.can("lead:read") ? [
          { href: "/dashboard/leads", label: "Pipeline", icon: <Board size={15} /> },
          { href: "/dashboard/leads/calls", label: "Calls", icon: <Phone size={15} /> },
        ] : []),
        { href: "/dashboard/leads/availability", label: "Availability", icon: <Building size={15} /> },
      ]}
    />
  );

  return (
    <>
      <PageHead
        title={
          <>
            Flat <span className="em">availability</span>
          </>
        }
        meta={
          tower
            ? units.length
              ? `${tower.name}: ${available.toLocaleString("en-IN")} of ${units.length.toLocaleString("en-IN")} available · updated ${when(tower.updatedAt)}`
              : `${tower.name}: no flats recorded yet`
            : "No towers yet"
        }
      />
      {tabs}
      <Flash text={error} name="error" />
      <Flash text={done} name="done" tone="info" />

      {towers.length > 1 && (
        <nav className="av-towers" aria-label="Towers">
          {towers.map((t) => (
            <Link
              key={t.id}
              href={`/dashboard/leads/availability?tower=${t.id}`}
              className={`av-tower${t.id === tower?.id ? " av-tower--on" : ""}`}
              aria-current={t.id === tower?.id ? "page" : undefined}
            >
              <strong>{t.name}</strong>
              <span>{t.project ?? "No project"}</span>
            </Link>
          ))}
        </nav>
      )}

      {!tower ? (
        <section className="card av-none">
          <p>No towers here yet.</p>
        </section>
      ) : units.length === 0 ? (
        mayImport ? (
          // With no flats the import is the whole screen's job, so it is the card, on one line.
          <>
            <ImportForm tower={tower} first />
            <LiveSheet tower={tower} feed={feed} project={mayProject ? project : null} canManage={mayFeed} />
          </>
        ) : (
          <section className="card av-none">
            <p>No flats recorded for {tower.name} yet.</p>
          </section>
        )
      ) : (
        <div className="split av-split">
          <div className="split__main">
          <section className="card av-flats" aria-labelledby="av-flats-h">
            <div className="card__head">
              <h2 id="av-flats-h">Flats</h2>
              <nav className="av-filter" aria-label="Show">
                {FILTERS.map((f) => (
                  <Link
                    key={f.key}
                    href={hrefFor(f.key === "ALL" ? {} : { status: f.key })}
                    className={`pill ${f.key === filter ? "pill--blue" : "pill--quiet"}`}
                    aria-current={f.key === filter ? "true" : undefined}
                  >
                    {f.label}
                  </Link>
                ))}
              </nav>
            </div>
            {shown.length === 0 ? (
              <p className="formfield__unset">None {filter === "ALL" ? "" : STATUS_LABEL[filter as UnitStatus].toLowerCase()} in {tower.name}.</p>
            ) : (
              <div className="av-scroll">
                <table className="av-table">
                  <thead>
                    <tr>
                      <th scope="col">Unit</th>
                      <th scope="col">Floor</th>
                      <th scope="col">Configuration</th>
                      <th scope="col" className="av-num">Carpet (sq ft)</th>
                      <th scope="col">Facing</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {shown.map((u) => (
                      <tr key={u.id} data-unit={u.unitNo}>
                        <th scope="row">
                          {u.wing && !u.unitNo.toLowerCase().startsWith(u.wing.toLowerCase()) ? `${u.wing} ` : ""}
                          {u.unitNo}
                        </th>
                        <td>{u.floor === null ? "" : u.floor === 0 ? "Ground" : u.floor}</td>
                        <td>{u.config ? configLabel(u.config) : <span className="av-faint">Not given</span>}</td>
                        <td className="av-num">{u.carpetSqft === null ? "" : u.carpetSqft.toLocaleString("en-IN")}</td>
                        <td>{u.facing ? FACING[u.facing] : ""}</td>
                        <td>
                          <span className={`pill pill--${TONE[u.status]}`}>{u.heldUntil ? "Held" : STATUS_LABEL[u.status]}</span>
                          {u.heldUntil && (
                            <span className="av-src">
                              until{" "}
                              {u.heldUntil.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                            </span>
                          )}
                          {u.source === "CRM" && <span className="av-src">from CRM</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          </div>

          <div className="split__side">
          <section className="card av-mix" aria-labelledby="av-mix-h">
            <div className="card__head">
              <h2 id="av-mix-h">By configuration</h2>
            </div>
            <table className="av-table av-table--mix">
              <thead>
                <tr>
                  <th scope="col">Configuration</th>
                  <th scope="col" className="av-num">Available</th>
                  <th scope="col" className="av-num">Blocked</th>
                  <th scope="col" className="av-num">Booked</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {byConfig.map((a) => (
                  <tr key={a.config || "none"}>
                    <th scope="row">{a.label}</th>
                    <td className="av-num av-num--lead">{a.available.toLocaleString("en-IN")}</td>
                    <td className="av-num">{a.blocked.toLocaleString("en-IN")}</td>
                    <td className="av-num">{a.booked.toLocaleString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {(feed || mayImport) && (
            <LiveSheet tower={tower} feed={feed} project={mayProject ? project : null} canManage={mayFeed} />
          )}

          {mayImport && (
            <details className="disclose av-update">
              <summary>
                Update from a sheet
              </summary>
              <div className="disclose__body">
                <ImportForm tower={tower} />
              </div>
            </details>
          )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A published sheet, read every few minutes: where it is read from and how
 * the last read went, read-only; the link changes behind Change.
 */
function LiveSheet({
  tower,
  feed,
  project,
  canManage,
}: {
  tower: { id: string; name: string };
  feed: FeedView | null;
  project: { id: string; name: string } | null;
  canManage: boolean;
}) {
  const host = feed ? new URL(feed.url).hostname : null;
  const result = feed?.lastResult;
  return (
    <section className="card av-live" aria-labelledby="av-live-h">
      <div className="card__head">
        <h2 id="av-live-h">Live sheet</h2>
        {feed ? (
          feed.lastError ? (
            <span className="pill pill--risk">Not read</span>
          ) : (
            <span className="pill pill--ok">On</span>
          )
        ) : (
          <span className="pill pill--quiet">Off</span>
        )}
      </div>
      {feed ? (
        <dl className="av-live__facts">
          <div>
            <dt>Read from</dt>
            <dd>{host}</dd>
          </div>
          {feed.kind === "PROJECT" && (
            <div>
              <dt>Covers</dt>
              <dd>Every tower of {feed.on}</dd>
            </div>
          )}
          <div>
            <dt>Last read</dt>
            <dd>{feed.lastFetchedAt ? when(feed.lastFetchedAt) : "Not yet"}</dd>
          </div>
          {feed.lastError ? (
            <div>
              <dt>Problem</dt>
              <dd>{feed.lastError}</dd>
            </div>
          ) : feed.lastChangedAt && result ? (
            <div>
              <dt>Last change</dt>
              <dd>
                {when(feed.lastChangedAt)}: {result.added} added, {result.changed} changed
                {result.refused ? `, ${result.refused} lines skipped` : ""}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="formfield__unset">Not linked.</p>
      )}
      {canManage && (
        <details className="disclose av-live__change">
          <summary>{feed ? "Change" : "Link a sheet"}</summary>
          <div className="disclose__body">
            <KeptForm action={saveFeedAction} className="av-live__form">
              <input type="hidden" name="tower" value={tower.id} />
              <div className="field">
                <label htmlFor={`av-url-${tower.id}`}>Published sheet link</label>
                <input
                  id={`av-url-${tower.id}`}
                  name="url"
                  type="url"
                  required
                  defaultValue={feed?.url ?? ""}
                  placeholder="https://docs.google.com/spreadsheets/d/e/.../pub?output=csv"
                  autoComplete="off"
                />
              </div>
              {project ? (
                <div className="field">
                  <label htmlFor={`av-covers-${tower.id}`}>Covers</label>
                  <select id={`av-covers-${tower.id}`} name="covers" defaultValue={feed?.nodeId ?? tower.id}>
                    <option value={tower.id}>{tower.name} only</option>
                    <option value={project.id}>Every tower of {project.name}</option>
                  </select>
                </div>
              ) : (
                <input type="hidden" name="covers" value={feed?.nodeId ?? tower.id} />
              )}
              <button type="submit" className="btn btn--ink btn--sm">
                {feed ? "Save link" : "Link sheet"}
              </button>
            </KeptForm>
            {feed && (
              <KeptForm action={saveFeedAction} className="av-live__form">
                <input type="hidden" name="tower" value={tower.id} />
                <input type="hidden" name="covers" value={feed.nodeId} />
                <input type="hidden" name="remove" value="1" />
                <button type="submit" className="btn btn--ghost btn--sm">
                  Stop reading this sheet
                </button>
              </KeptForm>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

/** The sheet import: the screen itself while a tower has no flats, a closed panel beside them after. */
function ImportForm({ tower, first = false }: { tower: { id: string; name: string }; first?: boolean }) {
  const id = `av-sheet-${tower.id}`;
  return (
    <KeptForm action={importAvailabilityAction} className={first ? "card av-import av-import--first" : "av-import"}>
      <input type="hidden" name="tower" value={tower.id} />
      <div className="av-import__row">
        <div className="av-import__text">
          <label className="av-import__label" htmlFor={id}>
            {first ? `Import ${tower.name}'s availability sheet` : `Choose ${tower.name}'s latest sheet`}
          </label>
          <p className="av-import__hint">
            Excel or CSV. One row per flat, with its unit number and status.{" "}
            <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(exampleSheet())}`} download="availability-example.csv">
              An example sheet
            </a>
          </p>
        </div>
        <input
          id={id}
          className="av-import__pick"
          type="file"
          name="sheet"
          required
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        />
        <button type="submit" className="btn btn--ink" data-import-sheet>
          {first ? "Import" : "Update availability"}
        </button>
      </div>
    </KeptForm>
  );
}
