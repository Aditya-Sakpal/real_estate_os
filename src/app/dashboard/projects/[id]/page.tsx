import Link from "next/link";
import type { ReactNode } from "react";
import { redirect, notFound } from "next/navigation";
import { inReach } from "@/lib/grant-rules";
import { getViewer } from "@/lib/console";
import { listProjects } from "@/lib/project";
import { listPhases, getExemption } from "@/lib/rera";
import { registrationFromDocuments } from "@/lib/extract";
import { linkedTo } from "@/lib/linked";
import { brainSummaries } from "@/lib/brain";
import { galleriesAt, locationAt } from "@/lib/visits";
import { withTenant } from "@/lib/db";
import { projectStatusOf, retirePlanOf } from "@/lib/project-life";
import { retireStops } from "@/lib/project-life-rules";
import { deletePhaseAction, deleteProjectAction, reactivateProjectAction, retireProjectAction } from "@/app/actions/project-life";
import { deleteBlockers } from "@/lib/node-delete";
import { deleteRefusal } from "@/lib/node-delete-rules";
import { ConfirmAction } from "@/components/ConfirmAction";
import { STATE_RULES, canAdvertise, effectiveValidTo, stateRule } from "@/lib/rera-rules";
import { adRuleFor } from "@/lib/rera-ad-rules";
import { hasAdapter } from "@/lib/rera-states";
import { canClear, type Gate } from "@/lib/readiness-rules";
import { onDate } from "@/lib/team";
import {
  createPhaseAction,
  recordRegistrationAction,
  attestExemptionAction,
} from "@/app/actions/rera";
import { Shield, ArrowUpRight, Check, Alert } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import { loadReview } from "@/lib/review";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { SiteLocation } from "./SiteLocation";
import { GalleryHosts } from "./GalleryHosts";
import { listHosts, projectCapacity } from "@/lib/slots";
import { occupancyDates } from "@/lib/occupancy";
import { recordOccupancyAction } from "@/app/actions/occupancy";
import { RegistrationFields, type StateOption } from "./RegistrationFields";
import { OpenDisclose } from "../OpenDisclose";
import "./project.css";

/**
 * One project: its towers with their registration and what is left before a
 * campaign, and beside them the project's facts, site and visit hours.
 *
 * Registration lives on the phase because each is a standalone registration
 * under Section 3. Exemption lives on the project because Section 3(2)(a)
 * measures across all phases. The forms that change either are closed until
 * somebody asks for them; a tower that needs one opens it from its own row.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("project:read") && !viewer.authz.can("rera:read")) {
    redirect("/dashboard");
  }

  const { id } = await params;
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // Only a message we signed is printed. The ids a success carries are used
  // to key the forms, so the next entry starts empty, and never shown.
  const error = readFlash(q, "error");
  const created = one(q.created) ?? "";
  const verified = one(q.verified) ?? "";

  const orgId = viewer.state.org.id;
  const projects = await listProjects(orgId);
  const project = projects.find((p) => p.id === id);
  if (!project) notFound();
  // Held here, not merely somewhere: another project's page is not this person's.
  if (!inReach(project.path, [...viewer.authz.scopesFor("project:read"), ...viewer.authz.scopesFor("rera:read")])) notFound();

  const [phases, exemption, location, hosts, galleryHosts, galleries, status, retirePlan, linkedFrom, review] = await Promise.all([
    listPhases(orgId, id),
    getExemption(orgId, id),
    locationAt(orgId, id),
    projectCapacity(orgId, id),
    listHosts(orgId, id),
    galleriesAt(orgId, id),
    withTenant(orgId, (sql) => projectStatusOf(sql, orgId, id)),
    withTenant(orgId, (sql) => retirePlanOf(sql, orgId, id)),
    linkedTo(orgId, id),
    loadReview(orgId, id, viewer.authz),
  ]);
  const waiting = review ? review.totals.values + review.totals.pictures + review.totals.flats + review.totals.drafts : 0;
  const retired = status === "RETIRED";
  const canRetire = viewer.authz.canAt("org:manage", project.path);
  const notice = readFlash(q, "notice");
  const [occupancy, deletable] = await Promise.all([
    occupancyDates(orgId, phases.map((p) => p.id)),
    // Why each place cannot be deleted, or null when it can: asked only of somebody who may delete.
    canRetire && !linkedFrom
      ? withTenant(orgId, async (sql) => {
          const why = new Map<string, string | null>();
          why.set(id, deleteRefusal("PROJECT", await deleteBlockers(sql, orgId, id)));
          for (const ph of phases) why.set(ph.id, deleteRefusal("PHASE", await deleteBlockers(sql, orgId, ph.id)));
          return why;
        })
      : Promise.resolve(new Map<string, string | null>()),
  ]);
  const ocCount = phases.filter((p) => occupancy.has(p.id)).length;
  // The six gates, for the towers of this project only.
  const gates = viewer.state.readiness.filter((r) => r.projectId === id);

  const canReadBrain = viewer.authz.can("brain:read");
  const brains = canReadBrain
    ? await brainSummaries(orgId, [project.id, ...phases.map((p) => p.id)])
    : new Map();

  const can = (perm: string) => viewer.authz.can(perm);
  // A project added from a developer: its towers and registrations are the developer's.
  const canAddPhase = viewer.authz.can("project:create") && !linkedFrom;
  const canEditLocation = canAddPhase || viewer.authz.can("brand:manage");
  const canManageRera = viewer.authz.can("rera:manage") && !linkedFrom;
  const rule = stateRule(exemption?.stateCode ?? "MH");
  const stateOptions: StateOption[] = STATE_RULES.map((s) => ({
    code: s.code,
    name: s.name,
    authority: s.authority,
    hint: s.patternHint ?? null,
    checked: hasAdapter(s.code),
    permit: adRuleFor(s.code)?.permitNo ?? false,
  }));

  const towers = phases.map((ph) => {
    const verdict = canAdvertise({
      status: ph.status,
      validTo: ph.validTo,
      extendedUntil: ph.extendedUntil,
      exemptionExpiresAt: exemption?.expiresAt ?? null,
    });
    const runsTo = effectiveValidTo(ph.validTo, ph.extendedUntil);
    const extended = !!ph.extendedUntil && runsTo !== effectiveValidTo(ph.validTo);
    return { ph, verdict, runsTo, extended, ready: gates.find((g) => g.phaseId === ph.id) ?? null };
  });
  // A tower that cannot be advertised for want of a registration. An exempt
  // one that lapsed needs the exemption attested again, not a number.
  const unregistered = towers.filter((t) => !t.verdict.ok && t.ph.status !== "EXEMPT");
  const readyCount = gates.filter((g) => g.ready).length;

  // Which forms open with the page: the one an address asked for, and the
  // add-a-phase form when there is nothing else to look at.
  const registerFor = phases.some((p) => p.id === one(q.register)) ? one(q.register) : undefined;
  // What an attached certificate already printed, so the form starts from it.
  const known = canManageRera && unregistered.length ? await registrationFromDocuments(orgId, unregistered.map((t) => t.ph.id)).catch(() => ({})) : {};
  const exemptOpen = one(q.exempt) === "1";
  const addOpen = one(q.add) === "1";

  const base = `/dashboard/projects/${project.id}`;
  const registerLink = (phaseId: string, cls: string, label: ReactNode) => (
    <OpenDisclose
      target="register"
      href={`${base}?register=${phaseId}#register`}
      pick={["phaseId", phaseId]}
      focus="registrationNo"
      className={cls}
    >
      {label}
    </OpenDisclose>
  );
  const exemptLink = (cls: string, label: ReactNode) => (
    <OpenDisclose target="exemption" href={`${base}?exempt=1#exemption`} focus="landAreaSqm" className={cls}>
      {label}
    </OpenDisclose>
  );

  const brain = brains.get(project.id);

  return (
    <>
      <PageHead
        back={{ label: "Projects", href: "/dashboard/projects" }}
        title={
          <>
            {project.name} in <span className="em">{project.city}</span>
          </>
        }
        meta={
          <>
            {linkedFrom ? `From ${linkedFrom.developer} · ` : null}Registers under {project.entityName} ·{" "}
            {phases.length === 0
              ? "no phases yet"
              : `${phases.length} ${phases.length === 1 ? "phase" : "phases"}`}
          </>
        }
        action={
          retired && canRetire ? (
            <ConfirmAction
              label="Reactivate project"
              title={`Reactivate ${project.name}?`}
              body="It comes back to Today and the pickers. Schedules stay stopped and ads stay paused until somebody starts them."
              confirmLabel="Reactivate project"
              action={reactivateProjectAction}
              fields={{ projectId: project.id }}
              size="md"
              testId="reactivate-project"
            />
          ) : retired ? null : canManageRera && unregistered.length > 0
            ? registerLink(
                unregistered[0].ph.id,
                "btn btn--ink",
                <>
                  Record a registration
                  <ArrowUpRight size={14} />
                </>,
              )
            : waiting > 0 && !linkedFrom
              ? (
                  <Link href={`/dashboard/projects/${project.id}/review`} className="btn btn--ink" data-review-link>
                    Review and approve · {waiting}
                    <ArrowUpRight size={14} />
                  </Link>
                )
              : null
        }
      />

      <Flash text={error} name="error" tone="risk" style={{ marginBottom: 16 }} />
      <Flash text={notice} name="notice" tone="info" style={{ marginBottom: 16 }} />
      {retired && (
        <p className="note siteloc__note" role="status" style={{ marginBottom: 16 }} data-project-retired>
          This project is retired. Nothing runs for it, and everything it holds stays here to read.
        </p>
      )}

      <div className="split">
        <div className="split__main">
          {/* --- the towers: registration and what is left before a campaign --- */}
          <section className="card" aria-labelledby="pj-phases">
            <div className="card__head">
              <h2 id="pj-phases">Phases</h2>
              {gates.length > 0 && (
                <span className={readyCount > 0 ? "pill pill--ok" : "pill pill--quiet"}>
                  {readyCount} of {gates.length} ready to advertise
                </span>
              )}
            </div>

            {phases.length === 0 ? (
              <div className="pjempty">
                <p className="pjempty__line">No phases yet.</p>
                {canAddPhase && <AddPhase projectId={project.id} created={created} />}
              </div>
            ) : (
              <div className="ptowers">
                {towers.map(({ ph, verdict, runsTo, extended, ready }) => {
                  const exempt = ph.status === "EXEMPT";
                  const fixRegistration = (cls: string, label: ReactNode) =>
                    exempt ? exemptLink(cls, label) : registerLink(ph.id, cls, label);
                  const regLine = ph.registrationNo
                    ? `${ph.stateCode} ${ph.registrationNo}${runsTo ? ` · to ${onDate(runsTo)}` : ""}${extended ? ", extended" : ""}`
                    : exempt
                      ? verdict.why
                      : "No registration recorded";
                  const next = ready?.next ?? null;

                  return (
                    <article
                      key={ph.id}
                      id={`phase-${ph.id}`}
                      className={`ptower${ready ? "" : " ptower--bare"}`}
                    >
                      <div className="ptower__id">
                        <div className="ptower__head">
                          <span className="ptower__name">{ph.name}</span>
                          <span className="person__when">
                            <span
                              className={
                                !verdict.ok
                                  ? "pill pill--risk"
                                  : exempt
                                    ? "pill pill--blue"
                                    : ph.lastCheckedAt
                                      ? "pill pill--ok"
                                      : "pill pill--warn"
                              }
                              title={
                                ph.status === "VERIFIED"
                                  ? ph.lastCheckedAt
                                    ? "Checked on the state's RERA portal"
                                    : "Recorded by a person, not yet checked on the portal"
                                  : undefined
                              }
                            >
                              <span className="pill__dot" />
                              {ph.status === "BLOCKED"
                                ? "Not registered"
                                : ph.status === "VERIFIED" && !ph.lastCheckedAt
                                  ? "Attested"
                                  : ph.status === "VERIFIED"
                                    ? "Verified"
                                    : ph.status === "EXEMPT"
                                      ? "Exempt"
                                      : ph.status}
                            </span>
                          </span>
                        </div>
                        <span className="ptower__reg">
                          {regLine}
                          {ph.registrationNo && !verdict.ok ? `. ${verdict.why}` : ""}
                        </span>
                        {ready?.daysLeft != null && ready.daysLeft <= 30 && (
                          <span className="pill pill--warn ptower__lapse">
                            <span className="pill__dot" />
                            Lapses in {ready.daysLeft} days
                          </span>
                        )}

                        <div className="ptower__act">
                          {ready?.ready ? (
                            <span className="pill pill--ok">
                              <Check size={11} />
                              Ready to advertise
                            </span>
                          ) : next && next.key === "registered" && canManageRera ? (
                            fixRegistration(
                              "btn btn--ink btn--sm",
                              <>
                                {exempt ? "Attest the exemption again" : next.action}
                                <ArrowUpRight size={13} />
                              </>,
                            )
                          ) : next && next.key !== "registered" && canClear(next, can) ? (
                            <Link href={next.href} className="btn btn--ink btn--sm">
                              {next.action}
                              <ArrowUpRight size={13} />
                            </Link>
                          ) : !ready && canReadBrain ? (
                            <Link href={`/dashboard/brain/${ph.id}`} className="btn btn--ghost btn--sm">
                              {brains.get(ph.id)?.published
                                ? `Brain v${brains.get(ph.id)!.published}`
                                : brains.get(ph.id)?.draft
                                  ? "Brain, in draft"
                                  : "Set up its Brain"}
                            </Link>
                          ) : null}
                          {deletable.get(ph.id) === null && (
                            <ConfirmAction
                              label="Delete"
                              title={`Delete ${ph.name}?`}
                              body={`${ph.name} and everything it holds go: its registration record, Brain, pictures, flat types and posts. This cannot be undone.`}
                              confirmLabel="Delete phase"
                              action={deletePhaseAction}
                              fields={{ phaseId: ph.id, projectId: project.id }}
                              tone="risk"
                              testId="delete-phase"
                            />
                          )}
                        </div>
                      </div>

                      {ready && (
                        <ol className="pgates" aria-label={`${ph.name}: ${ready.done} of ${ready.total} done`}>
                          {ready.gates.map((g) => (
                            <li key={g.key}>
                              <GateChip
                                gate={g}
                                isNext={next?.key === g.key}
                                open={
                                  g.key === "registered"
                                    ? g.state !== "done" && canManageRera
                                      ? (cls, inner) => fixRegistration(cls, inner)
                                      : null
                                    : canClear(g, can) || (g.key === "facts" && canReadBrain)
                                      ? (cls, inner) => (
                                          <Link href={g.href} className={cls} title={g.action}>
                                            {inner}
                                          </Link>
                                        )
                                      : null
                                }
                              />
                            </li>
                          ))}
                        </ol>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* --- the compliance forms, closed until a tower needs one ------- */}
          {canManageRera && phases.length > 0 && (
            <details className="disclose pjdisclose" id="register" open={!!registerFor}>
              <summary>
                Record a registration
                {unregistered.length > 0 && (
                  <span className="disclose__sub">
                    {unregistered.length} {unregistered.length === 1 ? "phase" : "phases"} not registered
                  </span>
                )}
              </summary>
              <div className="disclose__body">
                <KeptForm key={`reg-${verified}-${registerFor ?? ""}`} action={recordRegistrationAction}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <RegistrationFields
                    phases={phases.map((ph) => ({ id: ph.id, name: ph.name }))}
                    states={stateOptions}
                    entityName={project.entityName}
                    phaseId={registerFor ?? unregistered[0]?.ph.id}
                    known={known}
                  />
                </KeptForm>
              </div>
            </details>
          )}

          <details className="disclose pjdisclose" id="exemption" open={exemptOpen}>
            <summary>
              Exemption
              <span className="disclose__sub">
                {exemption
                  ? `${exemption.landAreaSqm} sq m · ${exemption.apartmentCount} apartments · ${exemption.stateCode}`
                  : "Not attested"}
              </span>
              {exemption && <span className="pill pill--blue pjdisclose__pill">Attested</span>}
            </summary>
            <div className="disclose__body">
              <p className="sub pjdisclose__lead">
                {exemption ? (
                  <>
                    Attested {onDate(exemption.attestedAt)}
                    {exemption.attestedByName ? ` by ${exemption.attestedByName}` : ""}. Expires{" "}
                    {onDate(exemption.expiresAt)}; attest again before then.
                  </>
                ) : (
                  <>
                    Exempt up to {rule?.landSqm ?? 500} sq m {rule?.combinator === "OR" ? "or" : "and"}{" "}
                    {rule?.apartments ?? 8} apartments, across all phases.
                  </>
                )}
              </p>

              {canManageRera ? (
                <KeptForm action={attestExemptionAction}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <div className="roleform__pair">
                    <div className="field">
                      <label htmlFor="landAreaSqm">Land area, sq m</label>
                      <input
                        id="landAreaSqm"
                        type="number"
                        step="0.01"
                        min="0"
                        name="landAreaSqm"
                        className="select-field"
                        defaultValue={exemption?.landAreaSqm ?? ""}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="apartmentCount">Apartments, all phases</label>
                      <input
                        id="apartmentCount"
                        type="number"
                        min="0"
                        name="apartmentCount"
                        className="select-field"
                        defaultValue={exemption?.apartmentCount ?? ""}
                        required
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="exemptState">State</label>
                    <select
                      id="exemptState"
                      name="stateCode"
                      className="select-field"
                      defaultValue={exemption?.stateCode ?? "MH"}
                      required
                    >
                      {STATE_RULES.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" className="btn btn--ghost">
                    {exemption ? "Re-attest exemption" : "Attest exemption"}
                  </button>
                </KeptForm>
              ) : (
                <p className="sub">A compliance officer attests this.</p>
              )}
            </div>
          </details>

          {phases.length > 0 && (
            <details className="disclose pjdisclose" id="occupancy">
              <summary>
                Occupancy certificate
                <span className="disclose__sub">
                  {ocCount ? `${ocCount} of ${phases.length} ${phases.length === 1 ? "phase" : "phases"} received` : "None received"}
                </span>
              </summary>
              <div className="disclose__body">
                <ul className="sub pjdisclose__lead">
                  {phases.map((ph) => (
                    <li key={ph.id}>
                      {ph.name}: {occupancy.has(ph.id) ? `received ${onDate(`${occupancy.get(ph.id)}T12:00:00Z`)}` : "not received"}
                    </li>
                  ))}
                </ul>
                {canManageRera ? (
                  <KeptForm action={recordOccupancyAction}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <div className="roleform__pair">
                      <div className="field">
                        <label htmlFor="ocPhase">Phase</label>
                        <select id="ocPhase" name="phaseId" className="select-field" defaultValue={phases[0].id} required>
                          {phases.map((ph) => (
                            <option key={ph.id} value={ph.id}>
                              {ph.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="ocReceivedOn">Received on</label>
                        <input id="ocReceivedOn" type="date" name="ocReceivedOn" className="select-field" />
                      </div>
                    </div>
                    <button type="submit" className="btn btn--ghost">
                      Save
                    </button>
                  </KeptForm>
                ) : null}
              </div>
            </details>
          )}
        </div>

        <aside className="split__side pjrail" aria-label="About this project">
          {/* The object every quote, reply and creative is built from. */}
          {canReadBrain && (
            <section className="card pjbrain" aria-labelledby="pj-brain">
              <div className="pjbrain__top">
                <span className="brainbanner__mark">
                  <Shield size={17} />
                </span>
                <div className="pjbrain__id">
                  <h2 id="pj-brain">Project Brain</h2>
                  <p className="sub">Price and claims for every tower</p>
                </div>
              </div>
              <div className="pjbrain__foot">
                {brain?.published ? (
                  <span className="pill pill--ok">
                    <span className="pill__dot" />
                    Version {brain.published} live
                  </span>
                ) : brain?.draft ? (
                  <span className="pill pill--warn">
                    <span className="pill__dot" />
                    Draft, not published
                  </span>
                ) : (
                  <span className="pill pill--quiet">Nothing published yet</span>
                )}
                <Link
                  href={`/dashboard/brain/${project.id}`}
                  className={brain?.published ? "btn btn--ghost btn--sm" : "btn btn--ink btn--sm"}
                >
                  {brain ? "Open" : "Set it up"}
                  <ArrowUpRight size={13} />
                </Link>
              </div>
            </section>
          )}

          {/* --- where the site is: the directions a buyer gets for a visit --- */}
          <SiteLocation
            nodeId={project.id}
            location={location}
            galleries={galleries.filter((g) => !g.inherited)}
            canEdit={canEditLocation}
          />
          <GalleryHosts
            projectId={project.id}
            capacity={hosts}
            hosts={galleryHosts}
            canEdit={viewer.authz.canAt("visit:manage", project.path)}
          />

          {/* --- a sold-out project: retired, read-only, behind a confirmation --- */}
          {canRetire && !retired && (
            <section className="card siteloc" aria-labelledby="pj-retire" data-retire-project>
              <div className="card__head">
                <h2 id="pj-retire">Sold out?</h2>
                <ConfirmAction
                  label="Retire project"
                  title={`Retire ${project.name}?`}
                  body={
                    <ul>
                      {retireStops(new Date().toISOString(), retirePlan).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  }
                  confirmLabel="Retire project"
                  action={retireProjectAction}
                  fields={{ projectId: project.id }}
                  tone="risk"
                  testId="retire-project"
                />
              </div>
            </section>
          )}

          {/* --- a project made by mistake: deleted, only while it holds nothing that is kept --- */}
          {deletable.has(project.id) && (
            <section className="card siteloc" aria-labelledby="pj-delete" data-delete-project>
              <div className="card__head">
                <h2 id="pj-delete">Made by mistake?</h2>
                {deletable.get(project.id) === null ? (
                  <ConfirmAction
                    label="Delete project"
                    title={`Delete ${project.name}?`}
                    body={`${project.name}${phases.length ? `, its ${phases.length === 1 ? "phase" : `${phases.length} phases`}` : ""} and everything ${phases.length ? "they hold" : "it holds"} go: registrations, Brain, pictures, flat types, campaigns and posts. This cannot be undone.`}
                    confirmLabel="Delete project"
                    action={deleteProjectAction}
                    fields={{ projectId: project.id }}
                    tone="risk"
                    testId="delete-project"
                  />
                ) : (
                  <button type="button" className="btn btn--ghost btn--sm" disabled>
                    Delete project
                  </button>
                )}
              </div>
              {deletable.get(project.id) && <p className="sub">{deletable.get(project.id)}</p>}
            </section>
          )}

          {canAddPhase && phases.length > 0 && (
            <details className="disclose pjdisclose" id="add-phase" open={addOpen}>
              <summary>Add a phase</summary>
              <div className="disclose__body">
                <AddPhase projectId={project.id} created={created} />
              </div>
            </details>
          )}
        </aside>
      </div>
    </>
  );
}

/** The one-field form that adds a phase (a tower) to the project. */
function AddPhase({ projectId, created }: { projectId: string; created: string }) {
  return (
    <KeptForm key={`phase-${created}`} action={createPhaseAction} className="invite" messageAt="bottom">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="text" name="name" placeholder="Tower C" aria-label="Phase name" maxLength={120} required />
      <button type="submit" className="btn btn--ink">
        Add phase
        <ArrowUpRight size={14} />
      </button>
    </KeptForm>
  );
}

/**
 * One gate as a small chip: done, blocked or still to do, and its state in a
 * few words. It is a link only where pressing it lands somewhere this person
 * can act, and never back onto this page.
 */
function GateChip({
  gate,
  isNext,
  open,
}: {
  gate: Gate;
  isNext: boolean;
  open: ((cls: string, inner: ReactNode) => ReactNode) | null;
}) {
  const cls = `pgate pgate--${gate.state}${isNext ? " pgate--next" : ""}${open ? " pgate--link" : ""}`;
  const inner = (
    <>
      <span className="pgate__mark" aria-hidden>
        {gate.state === "done" ? <Check size={10} /> : gate.state === "blocked" ? <Alert size={10} /> : gate.n}
      </span>
      <span className="pgate__body">
        <span className="pgate__label">{gate.label}</span>
        <span className="pgate__detail">{gate.detail}</span>
      </span>
    </>
  );
  return open ? (
    open(cls, inner)
  ) : (
    <span className={cls} title={`${gate.label}: ${gate.detail}`}>
      {inner}
    </span>
  );
}
