import Link from "next/link";
import { redirect } from "next/navigation";
import { sellsForOthers } from "@/lib/mandate-rules";
import { getViewer } from "@/lib/console";
import { listEntities } from "@/lib/entity";
import { listProjects } from "@/lib/project";
import { inReach } from "@/lib/grant-rules";
import { readinessLabel } from "@/lib/readiness-rules";
import { createProjectAction } from "@/app/actions/scope";
import { Project as ProjectIcon, Building, ArrowUpRight, Plus } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { OpenDisclose } from "./OpenDisclose";
import { PlanBuy } from "./PlanBuy";
import { planContext } from "@/lib/plan-purchase";
import { planRequired } from "@/lib/plan-purchase-rules";
import { STATE_NAMES, rupees as planRupees } from "@/lib/billing-rules";
import { downgradeView } from "@/lib/plan-renewal";
import { cancelDowngradeAction, requestDowngradeAction } from "@/app/actions/plans";
import { ConfirmAction } from "@/components/ConfirmAction";
import "./projects.css";
import "./planbuy.css";

/**
 * Projects: one card per project, each holding its towers and how far each
 * is from its first campaign.
 *
 * A project hangs off a region, which hangs off the entity that will register
 * it. The form asks for a city rather than a region, because a developer
 * thinks in cities and the middle node is bookkeeping.
 *
 * There is no RERA field here on purpose. Registration attaches to a PHASE,
 * since under the explanation to Section 3 each phase is a standalone
 * registration, and a project with no phases has nothing to register yet.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  const firm = sellsForOthers(viewer.orgType);
  if (!viewer.authz.can("project:read") && !viewer.authz.can("project:create")) {
    redirect("/dashboard");
  }

  const canCreate = viewer.authz.can("project:create");
  const [allProjects, allEntities] = await Promise.all([
    listProjects(viewer.state.org.id),
    listEntities(viewer.state.org.id),
  ]);
  // Only the projects this person reaches: a tower's staff see their project,
  // and a firm working through a mandate sees the projects it holds.
  const reach = [...new Set([...viewer.authz.scopesFor("project:read"), ...viewer.authz.scopesFor("project:create")])];
  const projects = allProjects.filter((p) => inReach(p.path, reach));
  const entities = canCreate ? allEntities : allEntities.filter((e) => projects.some((p) => p.entityId === e.id));
  // Already read once for this request, by the shell.
  const readiness = viewer.state.readiness;
  const q = await searchParams;
  // Only a message we signed is printed; `created` is only compared.
  const error = readFlash(q, "error");
  const saved = readFlash(q, "saved");
  const created = Array.isArray(q.created) ? q.created[0] : q.created;
  // In production a project comes with a plan. Read only where it applies.
  const plans =
    canCreate && !viewer.via && planRequired(process.env)
      ? await planContext(viewer.state.org.id, viewer.orgType)
      : null;
  const gate = plans?.gate ?? { kind: "FREE" as const };
  const canPay = viewer.authz.can("billing:manage");
  // A channel partner's move to a smaller plan, from the first of next month.
  const down = viewer.orgType === "CHANNEL_PARTNER" && !viewer.via ? await downgradeView(viewer.state.org.id) : null;
  const firstOf = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });
  const nextFirst = (() => {
    const t = new Date(Date.now() + 330 * 60_000);
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  })();
  const states = Object.entries(STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1]));
  const buyCtx = plans && {
    today: plans.today,
    earlierPlans: plans.earlierPlans,
    hadPilot: plans.hadPilot,
    activeNow: plans.activeNow,
    test: plans.test,
    open: plans.open,
    buyerState: plans.buyerState,
    sellerState: plans.sellerState,
    upgrade: plans.upgrade,
  };
  const firmNeedsPlan = gate.kind === "NEED_FIRM_PLAN";
  const firmFull = gate.kind === "FIRM_FULL";
  const canAdd = canCreate && entities.length > 0 && !firmNeedsPlan && !firmFull;
  // The form opens with the page when asked for, or when there is nothing
  // else here yet.
  const addOpen = (Array.isArray(q.new) ? q.new[0] : q.new) === "1" || projects.length === 0;

  return (
    <>
      <PageHead
        title={
          <>
            What you are <span className="em">selling</span>
          </>
        }
        meta={
          <>
            {projects.length === 0
              ? "No projects yet"
              : `${projects.length} ${projects.length === 1 ? "project" : "projects"}`}{" "}
            · {viewer.state.org.displayName}
          </>
        }
        action={
          canAdd ? (
            <OpenDisclose
              target="new-project"
              href="/dashboard/projects?new=1#new-project"
              focus="name"
              className="btn btn--ink"
            >
              New project
              <ArrowUpRight size={14} />
            </OpenDisclose>
          ) : null
        }
      />

      <Flash text={error} name="error" tone="risk" style={{ marginBottom: 16 }} />
      <Flash text={saved} name="saved" tone="info" style={{ marginBottom: 16 }} />

      {firmNeedsPlan && buyCtx && (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="firm-plan-title">
          <div className="card__head">
            <h2 id="firm-plan-title">Choose a plan for your firm</h2>
          </div>
          <PlanBuy
            scope="ORG"
            entities={[]}
            firm={firm}
            firmName={viewer.state.org.displayName}
            ctx={buyCtx}
            canPay={canPay}
            states={states}
          />
        </section>
      )}

      {gate.kind === "FIRM_PLAN" && (
        <div className="planfirm">
          <span className="pill pill--blue">{gate.plan} plan</span>
          <span className="pill pill--quiet">
            {gate.left} of {gate.cap} projects left
          </span>
        </div>
      )}

      {firmFull && gate.kind === "FIRM_FULL" && (
        <div className="planfirm">
          <span className="pill pill--warn">
            {gate.plan} plan: all {gate.cap} projects in use
          </span>
          {!buyCtx?.upgrade && <span className="sub">You are on the biggest plan. Retire a sold-out project to free its place.</span>}
        </div>
      )}

      {(gate.kind === "FIRM_PLAN" || gate.kind === "FIRM_FULL") && buyCtx?.upgrade && (
        <details className="card disclose" style={{ marginBottom: 16 }} open={firmFull} data-plan-upgrade>
          <summary className="card__head">
            <h2>Move to a bigger plan</h2>
          </summary>
          <PlanBuy
            scope="ORG"
            entities={[]}
            firm={firm}
            firmName={viewer.state.org.displayName}
            ctx={buyCtx}
            canPay={canPay}
            states={states}
          />
        </details>
      )}

      {down?.pending && (
        <div className="planfirm" data-plan-change>
          <span className="pill pill--blue">
            Moves to {down.pending.label} on {firstOf(down.pending.effectiveOn)}
          </span>
          {canPay && (
            <ConfirmAction
              label="Stay on my plan"
              title="Stay on your plan?"
              body={`Your firm stays on its plan and does not move to ${down.pending.label}.`}
              confirmLabel="Stay on my plan"
              action={cancelDowngradeAction}
              fields={{ change: down.pending.id }}
              tone="ghost"
              testId="cancel-plan-change"
            />
          )}
        </div>
      )}

      {down && !down.pending && down.options.length > 0 && canPay && (
        <details className="card disclose" style={{ marginBottom: 16 }} data-plan-downgrade>
          <summary className="card__head">
            <h2>Move to a smaller plan</h2>
          </summary>
          <ul className="plandown">
            {down.options.map((p) => (
              <li key={p.key} className="plandown__row">
                <span className="plandown__what">
                  <strong>{p.label}</strong>
                  <span className="sub">
                    {p.projects} projects · {planRupees(p.pricePaise)} a month
                  </span>
                  {p.refusal && <span className="sub plandown__why">{p.refusal}</span>}
                </span>
                {p.refusal ? (
                  <button type="button" className="btn btn--ghost btn--sm" disabled>
                    Move to {p.label}
                  </button>
                ) : (
                  <ConfirmAction
                    label={`Move to ${p.label} from ${firstOf(nextFirst)}`}
                    title={`Move to ${p.label}?`}
                    body={`From ${firstOf(nextFirst)} your firm is on ${p.label}: ${p.projects} projects and its allowance. This month stays as it is.`}
                    confirmLabel={`Move to ${p.label}`}
                    action={requestDowngradeAction}
                    fields={{ to: p.key }}
                    tone="ghost"
                    testId={`plan-down-${p.key}`}
                  />
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {canCreate && entities.length === 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card__head">
            <h2>{firm ? "Add the developer first" : "Add a legal entity first"}</h2>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <span className="empty__mark" style={{ width: 38, height: 38, flex: "none", margin: 0 }}>
              <Building size={17} />
            </span>
            <div>
              <p className="sub" style={{ maxWidth: "62ch", margin: 0 }}>
                {firm ? "Add the developer company each project you sell is registered under." : "Add the company each project registers under."}
              </p>
              <Link
                href="/dashboard/settings/entities"
                className="btn btn--ink btn--sm"
                style={{ marginTop: 12 }}
              >
                {firm ? "Add a developer" : "Add an entity"}
                <ArrowUpRight size={13} />
              </Link>
            </div>
          </div>
        </section>
      )}

      {(projects.length > 0 || canAdd) && (
        <section className="card" aria-labelledby="projects-title">
          <div className="card__head">
            <h2 id="projects-title">Projects</h2>
            {projects.length > 0 && <span className="pill pill--quiet">{projects.length}</span>}
          </div>

          <div className="projgrid">
            {projects.map((p) => {
              const towers = readiness.filter((r) => r.projectId === p.id);
              return (
                <article key={p.id} className="projcard">
                  <Link href={`/dashboard/projects/${p.id}`} className="projcard__head">
                    <span className="projcard__mark" aria-hidden>
                      <ProjectIcon size={15} />
                    </span>
                    <span className="projcard__id">
                      <strong>
                        {p.name}
                        {created === p.path && <span className="pill pill--ok">New</span>}
                      </strong>
                      <small>
                        {p.city} · {p.entityName}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </Link>

                  {towers.length > 0 ? (
                    <ul className="projcard__towers">
                      {towers.map((t) => (
                        <li key={t.phaseId}>
                          <Link href={`/dashboard/projects/${p.id}#phase-${t.phaseId}`} className="projtower">
                            <span className="projtower__name">{t.phaseName}</span>
                            <span className="projtower__bar" aria-hidden>
                              {t.gates.map((g) => (
                                <span key={g.key} className={`projtower__seg projtower__seg--${g.state}`} />
                              ))}
                            </span>
                            <span
                              className={
                                t.blocked ? "pill pill--risk" : t.ready ? "pill pill--ok" : "pill pill--quiet"
                              }
                            >
                              {readinessLabel(t)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : p.phaseCount === 0 ? (
                    <p className="projcard__none">
                      <span className="pill pill--warn">No phase yet</span>
                    </p>
                  ) : (
                    <p className="projcard__none">
                      {p.phaseCount} {p.phaseCount === 1 ? "phase" : "phases"}
                    </p>
                  )}
                </article>
              );
            })}

            {canAdd && (
              <details className="projadd" id="new-project" open={addOpen}>
                <summary>
                  <span className="projadd__plus" aria-hidden>
                    <Plus size={15} />
                  </span>
                  Add a project
                </summary>

                {gate.kind === "BUY_WITH_PROJECT" && buyCtx ? (
                  <PlanBuy
                    scope="PROJECT"
                    entities={entities.map((e) => ({ id: e.id, name: e.name }))}
                    firm={firm}
                    firmName={viewer.state.org.displayName}
                    ctx={buyCtx}
                    canPay={canPay}
                    states={states}
                  />
                ) : (
                /* Kept, so a refusal leaves the chosen entity chosen: a redirect put
                    the select back on the first entity and a second press filed the
                    project under the wrong company. Keyed on what was just created,
                    so a success starts the next one empty. */
                <KeptForm key={`new-${created ?? ""}`} action={createProjectAction} className="projadd__form">
                  <div className="field">
                    <label htmlFor="name">Project name</label>
                    <input
                      id="name"
                      type="text"
                      name="name"
                      placeholder="Trees"
                      maxLength={120}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="city">City</label>
                    <input id="city" type="text" name="city" placeholder="Pune" maxLength={120} required />
                  </div>
                  <div className="field">
                    <label htmlFor="entityId">{firm ? "Developer" : "Registers under"}</label>
                    <select id="entityId" name="entityId" className="select-field" required>
                      {entities.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button type="submit" className="btn btn--ink">
                    Create project
                    <ArrowUpRight size={14} />
                  </button>
                </KeptForm>
                )}
              </details>
            )}
          </div>
        </section>
      )}

      {projects.length === 0 && !canAdd && !(canCreate && entities.length === 0) && (
        <section className="card">
          <div className="empty">
            <div className="empty__mark">
              <ProjectIcon size={19} />
            </div>
            No projects yet.
          </div>
        </section>
      )}
    </>
  );
}
