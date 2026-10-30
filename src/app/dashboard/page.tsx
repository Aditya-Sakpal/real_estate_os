import Link from "next/link";
import { redirect } from "next/navigation";
import { lastDay, longDay, sellsForOthers, showRate } from "@/lib/mandate-rules";
import { mandateTerms } from "@/lib/mandates";
import { resolveAuthz } from "@/lib/rbac";
import { AskLonger } from "@/app/workspace/AskLonger";
import { getViewer } from "@/lib/console";
import { PageHead } from "@/components/shell/PageHead";
import { GatesMini } from "@/components/shell/Gates";
import "./today.css";
import {
  Alert,
  Clock,
  Person,
  ArrowUpRight,
  Check,
  Shield,
  Building,
  Project as ProjectIcon,
} from "@/components/icons";

/**
 * Today: the one screen every member has, whatever they hold.
 *
 * It answers two questions and deliberately not a third. What needs me, which
 * is the queue. And what is standing between each tower and a campaign, which
 * is the gates. It does not answer how we are doing: this product's own rule
 * is that every role opens to a queue of things needing action, and a metrics
 * wall is the thing that rule exists to prevent.
 *
 * The organisation's own particulars used to sit at the foot of this screen,
 * including its scope path and its cell. Neither is a thing a sales head acts
 * on and both name internals, so they live in Settings now.
 */
export default async function Today() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");

  const { state } = viewer;
  const firstName = (viewer.name ?? "").split(/\s+/)[0] || null;
  const can = (p: string) => viewer.authz.can(p);
  // Through a mandate: its terms, and whether this person may ask for it to run longer (their own firm's admin).
  const [terms, firmAdmin] = viewer.via
    ? await Promise.all([
        mandateTerms(state.org.id, viewer.via.firmOrgId),
        resolveAuthz(viewer.userId, viewer.via.firmOrgId).then((a) => a.can("org:manage")),
      ])
    : [[], false];

  const steps = [
    {
      n: 1,
      title: "Add a second admin",
      why: "If this account is lost, nobody can manage the organisation. Add a second admin.",
      href: "/dashboard/team",
      cta: "Invite admin",
      done: state.adminCount >= 2,
      Icon: Person,
    },
    {
      n: 2,
      title: sellsForOthers(viewer.orgType) ? "Add a developer you sell for" : "Create your legal entity",
      why:
        sellsForOthers(viewer.orgType)
          ? "The developer company a project you sell is registered under, named exactly as on the RERA registration."
          : "The company your project is registered under, named exactly as on the RERA registration.",
      href: "/dashboard/settings/entities",
      cta: sellsForOthers(viewer.orgType) ? "Add developer" : "Add entity",
      done: state.entityCount > 0,
      Icon: Building,
    },
    {
      n: 3,
      title: sellsForOthers(viewer.orgType) ? "Add a project you sell" : "Create your first project",
      why: "Leads, site visits and campaigns all belong to a project.",
      href: "/dashboard/projects",
      cta: "New project",
      done: state.projects.length > 0,
      Icon: ProjectIcon,
    },
  ];
  const currentStep = steps.find((s) => !s.done)?.n ?? 0;

  // What is left to do, closest to done first, so the shortest remaining job
  // leads. The towers already clear are counted rather than listed: a row
  // with nothing to press on it is a row that pushes the work down the page.
  const working = state.readiness
    .filter((p) => !p.ready)
    .sort((a, b) => Number(a.blocked) - Number(b.blocked) || b.done - a.done);
  const readyCount = state.readiness.length - working.length;

  const markFor = (sev: string) =>
    sev === "risk" ? "qi__mark--risk" : sev === "warn" ? "qi__mark--warn" : "qi__mark--info";

  return (
    <>
      <PageHead
        title={
          firstName ? (
            <>
              {firstName}, here is what <span className="em">needs</span> you
            </>
          ) : (
            <>
              What <span className="em">needs</span> you
            </>
          )
        }
        meta={
          state.queue.length === 0
            ? "Nothing waiting. Everything the system could handle, it handled."
            : `${state.queue.length} ${state.queue.length === 1 ? "item" : "items"} · ${state.org.displayName}`
        }
      />

      {state.isFreshTenant && (
        <section className="setup" aria-label="Setup">
          {steps.map((s) => {
            const isNow = s.n === currentStep;
            const cls = s.done
              ? "step step--done"
              : isNow
                ? "step step--now"
                : `step step--${s.n}`;
            return (
              <div key={s.n} className={cls}>
                <div className="step__head">
                  <span className="step__marker" aria-hidden>
                    {s.done ? <Check size={12} /> : s.n}
                  </span>
                  <div className="step__title">{s.title}</div>
                </div>
                <p className="step__why">{s.why}</p>
                <div className="step__act">
                  {s.done ? (
                    <span className="pill pill--ok">
                      <span className="pill__dot" />
                      Complete
                    </span>
                  ) : (
                    <Link
                      href={s.href}
                      className={isNow ? "btn btn--light" : "btn btn--ink"}
                    >
                      {s.cta}
                      <ArrowUpRight size={14} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {terms.length > 0 && (
        <section className="card today-mandate" id="your-mandate" aria-label="Your mandate">
          <div className="card__head">
            <h2>
              Your mandate with {terms[0].developer}
            </h2>
            <span className="pill pill--blue">Through {viewer.via?.firmName}</span>
          </div>
          <ul className="today-mandate__list">
            {terms.map((t) => {
              const asked = t.extensionAskedAt ? lastDay(t.extensionAskedAt) : null;
              return (
                <li key={t.id} className="today-mandate__row">
                  <span className="today-mandate__what">
                    <span className="today-mandate__name">{t.projects.join(", ")}</span>
                    <span className="today-mandate__line">
                      {showRate(t.rate)} on every booking · until {longDay(lastDay(t.validTo))}
                      {t.tailDays > 0 ? ` · then ${t.tailDays} days on buyers who came during it` : ""}
                    </span>
                  </span>
                  {asked ? (
                    <span className="pill pill--quiet">Asked to run longer on {longDay(asked)}</span>
                  ) : firmAdmin ? (
                    <AskLonger mandateId={t.id} />
                  ) : (
                    <span className="today-mandate__line">Your firm&rsquo;s admin can ask to run it longer.</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className={`today${state.readiness.length > 0 ? "" : " today--solo"}`}>
        <section className="card today__queue" aria-label="Queue">
          <div className="card__head">
            <h2>Queue</h2>
            {state.queue.length > 0 && (
              <span className="pill pill--quiet">
                {state.queue.filter((q) => q.severity === "risk").length} blocking
              </span>
            )}
          </div>

          {state.queue.length === 0 ? (
            <div className="empty">
              <div className="empty__mark">
                <Shield size={20} />
              </div>
              Nothing needs you right now.
            </div>
          ) : (
            <div className="queue">
              {state.queue.map((item) => {
                // No resolvers: the item only opens a screen, so anybody who sees it may follow it.
                const canResolve = item.resolvers.length === 0 || item.resolvers.some((p) => viewer.authz.can(p));
                const Icon =
                  item.severity === "risk" ? Alert : item.severity === "warn" ? Clock : Person;
                return (
                  <Link key={item.id} href={item.href} className="qi">
                    <span className={`qi__mark ${markFor(item.severity)}`}>
                      <Icon size={15} />
                    </span>
                    <span className="qi__body">
                      <span className="qi__title">{item.title}</span>
                      <p className="qi__why">{item.why}</p>
                    </span>
                    <span className="qi__tail">
                      {item.tag && (
                        <span className={`pill pill--${item.tag.tone}`}>{item.tag.text}</span>
                      )}
                      {canResolve ? (
                        <span className="qi__do">
                          {item.action}
                          <ArrowUpRight size={13} />
                        </span>
                      ) : (
                        <span className="pill pill--quiet">View only</span>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
        {state.readiness.length > 0 && (
          <section className="card today__towers" aria-label="Towers">
            <div className="card__head">
              <h2>Before a campaign</h2>
              {readyCount > 0 && (
                <span className="pill pill--ok">
                  <span className="pill__dot" />
                  {readyCount} ready
                </span>
              )}
            </div>

            {working.length === 0 ? (
              <div className="empty">
                <div className="empty__mark">
                  <Check size={20} />
                </div>
                Every tower is ready to advertise.
              </div>
            ) : (
              <div className="today__gates">
                {working.slice(0, 6).map((p) => (
                  <GatesMini
                    key={p.phaseId}
                    readiness={p}
                    can={can}
                    name={`${p.projectName} ${p.phaseName}`}
                    href={`/dashboard/projects/${p.projectId}`}
                    note={
                      p.daysLeft !== null && p.daysLeft <= 30 ? (
                        <span className="pill pill--warn" style={{ justifySelf: "start" }}>
                          <span className="pill__dot" />
                          Lapses in {p.daysLeft} days
                        </span>
                      ) : undefined
                    }
                  />
                ))}

                {working.length > 6 && (
                  <Link href="/dashboard/projects" className="towers__more">
                    {working.length - 6} more in Projects
                    <ArrowUpRight size={13} />
                  </Link>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
