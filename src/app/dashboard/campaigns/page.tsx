import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listProjects } from "@/lib/project";
import { inReach } from "@/lib/grant-rules";
import { listPhases } from "@/lib/rera";
import { brainSummaries } from "@/lib/brain";
import { briefCounts } from "@/lib/campaign";
import { canAdvertise, effectiveValidTo } from "@/lib/rera-rules";
import { onDate } from "@/lib/team";
import { Alert, ArrowUpRight, Campaign, ChevronRight, Clock } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import { reviewQueue } from "@/lib/post";
import { awaitingReview } from "@/lib/post-rules";

/**
 * What stands between a phase and its first advertisement.
 *
 * Which phases could carry an ad right now, and what has to happen to the
 * rest. Every row resolves somewhere that exists: the Brain, the
 * registration record, or the campaigns for that project or phase.
 */

type Severity = "risk" | "warn" | "info";

type Block = {
  id: string;
  severity: Severity;
  title: string;
  why: string;
  href: string;
  action: string;
  resolver: string;
  tag?: { text: string; tone: string };
};

const markFor = (sev: Severity) =>
  sev === "risk" ? "qi__mark--risk" : sev === "warn" ? "qi__mark--warn" : "qi__mark--info";

export default async function CampaignsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");

  const orgId = viewer.state.org.id;
  const reach = viewer.authz.scopesFor("campaign:read");
  const [allProjects, queue] = await Promise.all([
    listProjects(orgId),
    reviewQueue(orgId, { limit: 200, scopes: reach }),
  ]);
  const projects = allProjects.filter((p) => inReach(p.path, reach));
  const phaseGroups = await Promise.all(
    projects.map(async (project) => ({
      project,
      phases: (await listPhases(orgId, project.id)).filter((ph) => inReach(ph.path, reach)),
    })),
  );

  const brainIds = phaseGroups.flatMap(({ project, phases }) => [
    project.id,
    ...phases.map((phase) => phase.id),
  ]);
  const [brains, briefs] = brainIds.length
    ? await Promise.all([brainSummaries(orgId, brainIds), briefCounts(orgId, brainIds)])
    : [new Map(), new Map()];

  const adState = (phase: { status: string; validTo: string | null; extendedUntil: string | null }) =>
    canAdvertise({
      status: phase.status as "VERIFIED" | "EXEMPT" | "BLOCKED",
      validTo: phase.validTo,
      extendedUntil: phase.extendedUntil,
      exemptionExpiresAt: null,
    });

  // Only the ones a person can still act on. A blocked post is shown in the
  // queue so its reason can be fixed, and counting it here would read as work
  // waiting that nobody can do.
  const waiting = awaitingReview(queue);

  const phaseCount = phaseGroups.reduce((sum, g) => sum + g.phases.length, 0);
  const readyCount = phaseGroups.reduce(
    (sum, g) => sum + g.phases.filter((p) => adState(p).ok).length,
    0,
  );

  // Brain first where a phase is already clear to advertise, registration
  // first where it is not: a signed price on a phase nobody may advertise is
  // work that cannot be spent.
  const blocks: Block[] = [];

  for (const { project, phases } of phaseGroups) {
    const projectBrain = brains.get(project.id);
    if (!projectBrain?.published) {
      blocks.push({
        id: `brain-${project.id}`,
        severity: "warn",
        title: `${project.name} has no published Brain`,
        why: "Facts set on the project carry down to every phase. Each phase still signs its own registration facts.",
        href: `/dashboard/brain/${project.id}`,
        action: projectBrain?.draft ? "Finish the draft" : "Open the Brain",
        resolver: "brain:read",
        tag: projectBrain?.draft
          ? { text: `Draft v${projectBrain.draft}`, tone: "warn" }
          : undefined,
      });
    } else if (!briefs.get(project.id)?.total) {
      blocks.push({
        id: `brief-${project.id}`,
        severity: "info",
        title: `${project.name} has no campaign brief`,
        why: "The facts are signed. What is missing is the job: who to reach, and in which languages.",
        href: `/dashboard/campaigns/${project.id}`,
        action: "Write the brief",
        resolver: "campaign:create",
      });
    }

    for (const phase of phases) {
      const verdict = adState(phase);
      if (!verdict.ok) {
        blocks.push({
          id: `rera-${phase.id}`,
          severity: "risk",
          title: `${phase.name} cannot be advertised`,
          why: verdict.why,
          href: `/dashboard/projects/${project.id}`,
          action: "Open the registration",
          resolver: "rera:read",
          tag: { text: "Blocked", tone: "risk" },
        });
        continue;
      }

      const phaseBrain = brains.get(phase.id);
      if (!phaseBrain?.published) {
        blocks.push({
          id: `brain-${phase.id}`,
          severity: "warn",
          title: `${phase.name} has no published Brain`,
          why: "This phase has not signed its registration facts yet.",
          href: `/dashboard/brain/${phase.id}`,
          action: phaseBrain?.draft ? "Finish the draft" : "Open the Brain",
          resolver: "brain:read",
          tag: phaseBrain?.draft
            ? { text: `Draft v${phaseBrain.draft}`, tone: "warn" }
            : undefined,
        });
        continue;
      }

      if (!briefs.get(phase.id)?.total) {
        blocks.push({
          id: `brief-${phase.id}`,
          severity: "info",
          title: `${phase.name} has no campaign brief`,
          why: "Registered, and the facts are signed. Say what the campaign is for.",
          href: `/dashboard/campaigns/${phase.id}`,
          action: "Write the brief",
          resolver: "campaign:create",
        });
      }
    }
  }

  const rank: Record<Severity, number> = { risk: 0, warn: 1, info: 2 };
  blocks.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return (
    <>
      <PageHead
        title={
          <>
            Before an ad can <span className="em">run</span>
          </>
        }
        meta="A phase needs a registration that is in date and a published Brain to quote from."
        action={
          // The screens beside this one are in the list on the left. The one
          // kept up here is the queue, and only while something waits on it.
          waiting > 0 ? (
            <Link href="/dashboard/campaigns/queue" className="btn btn--ink" data-queue>
              {waiting} waiting to go out
              <ArrowUpRight size={14} />
            </Link>
          ) : null
        }
      />

      {/* Only when something needs somebody. An empty "Needs you" card with a
          count of 0 is a heading announcing nothing; when every phase is clear
          the phase list below already says so. The one empty state kept is
          the day-one tenant, where there is no list below to say anything. */}
      {phaseCount === 0 && blocks.length === 0 && (
        <section className="card">
          <div className="empty" style={{ padding: "26px 20px" }}>
            <div className="empty__mark">
              <Campaign size={19} />
            </div>
            Add a project and its phases first.
          </div>
        </section>
      )}

      {blocks.length > 0 && (
      <section className="card">
        <div className="card__head">
          <h2>Needs you</h2>
          <span className="pill pill--quiet">{blocks.length}</span>
        </div>
          <div className="queue">
            {blocks.map((block) => {
              const canResolve = viewer.authz.can(block.resolver);
              const Icon =
                block.severity === "risk" ? Alert : block.severity === "warn" ? Clock : Campaign;
              return (
                <Link key={block.id} href={block.href} className="qi">
                  <span className={`qi__mark ${markFor(block.severity)}`}>
                    <Icon size={15} />
                  </span>
                  <span className="qi__body">
                    <span className="qi__title">{block.title}</span>
                    <p className="qi__why">{block.why}</p>
                  </span>
                  <span className="qi__tail">
                    {block.tag && (
                      <span className={`pill pill--${block.tag.tone}`}>{block.tag.text}</span>
                    )}
                    {canResolve ? (
                      <span className="qi__do">
                        {block.action}
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
      </section>
      )}

      {phaseCount > 0 && (
        <section className="card" style={{ marginTop: blocks.length > 0 ? 16 : 0 }}>
          <div className="card__head">
            <h2>Where each phase stands</h2>
            <span className="pill pill--quiet">
              {readyCount} of {phaseCount} clear
            </span>
          </div>
          <div className="campaignprojects">
            {phaseGroups.map(({ project, phases }) => (
              <div key={project.id} className="campaignproject">
                <Link href={`/dashboard/campaigns/${project.id}`} className="campaignproject__head">
                  <strong>{project.name}</strong>
                  <small>{project.city}</small>
                </Link>
                <div className="campaignproject__rows">
                  {/* Every row opens its own campaigns: the project's own row
                      its project-wide briefs, a tower's row that tower's. */}
                  <Link href={`/dashboard/campaigns/${project.id}`} className="campaignline campaignline--link">
                    <span className="campaignline__name">All of {project.name}</span>
                    <span className="campaignline__status">
                      <BrainPill summary={brains.get(project.id)} />
                      <BriefPill count={briefs.get(project.id)} />
                    </span>
                    <ChevronRight size={14} />
                  </Link>
                  {phases.map((phase) => {
                    const verdict = adState(phase);
                    return (
                      <Link key={phase.id} href={`/dashboard/campaigns/${phase.id}`} className="campaignline campaignline--phase campaignline--link">
                        <span className="campaignline__name">
                          {phase.name}
                          {phase.validTo && <small>Registered to {onDate(effectiveValidTo(phase.validTo, phase.extendedUntil) ?? phase.validTo)}</small>}
                        </span>
                        <span className="campaignline__status">
                          <BrainPill summary={brains.get(phase.id)} />
                          <BriefPill count={briefs.get(phase.id)} />
                          {/* The registration only. Saying "ad-ready" here
                              would contradict the row above it: a phase can
                              be clear under Section 3 and still have no
                              signed facts to put in the advertisement. */}
                          <span className={verdict.ok ? "pill pill--ok" : "pill pill--risk"}>
                            <span className="pill__dot" />
                            {verdict.ok ? "RERA clear" : "RERA blocked"}
                          </span>
                        </span>
                        <ChevronRight size={14} />
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Read-only, like every other pill. The row's name is what links. */
function BriefPill({ count }: { count: { total: number; ready: number } | undefined }) {
  const total = count?.total ?? 0;
  if (total === 0) return <span className="pill pill--quiet">No brief</span>;
  if (count?.ready) return <span className="pill pill--blue">{count.ready} ready</span>;
  return <span className="pill pill--blue">{total} draft</span>;
}

function BrainPill({
  summary,
}: {
  summary: { published: number | null; draft: number | null } | undefined;
}) {
  if (summary?.published) return <span className="pill pill--ok">Brain v{summary.published}</span>;
  if (summary?.draft) return <span className="pill pill--warn">Draft v{summary.draft}</span>;
  return <span className="pill pill--quiet">No Brain</span>;
}
