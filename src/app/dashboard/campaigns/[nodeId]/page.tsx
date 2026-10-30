import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getViewer } from "@/lib/console";
import { briefCounts, listBriefs, type BriefRow } from "@/lib/campaign";
import { listPhases } from "@/lib/rera";
import { canAdvertise } from "@/lib/rera-rules";
import { PageHead } from "@/components/shell/PageHead";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { briefFitsNode, briefGaps, briefLine } from "@/lib/campaign-rules";
import { createBriefAction } from "@/app/actions/campaign";
import { onDate } from "@/lib/team";
import { KeptForm } from "@/components/KeptForm";
import {
  ArrowUpRight,
  ChevronRight,
  Campaign,
  Plus,
  Project as ProjectIcon,
} from "@/components/icons";
import "./node-briefs.css";

/**
 * The campaigns running for one project or phase.
 *
 * A node carries several briefs at once. A launch campaign, an NRI campaign
 * and a festive campaign are three different jobs against the same building,
 * so this is a list rather than a single form.
 */
export default async function NodeBriefsPage({
  params,
}: {
  params: Promise<{ nodeId: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  // The page's own gate. Filtering the rail is presentation.
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");

  const { nodeId } = await params;

  const node = await resolveScopeNode(viewer.state.org.id, nodeId);
  if (!node || !briefFitsNode(node.kind)) notFound();
  if (!viewer.authz.canAt("campaign:read", node.path)) notFound();

  const orgId = viewer.state.org.id;
  // A project's campaigns run for every tower under it, and a tower has
  // campaigns of its own. Each page names the other, so neither is missed.
  const projectId =
    node.kind === "PHASE"
      ? viewer.state.places.find((pl) => pl.id === node.id)?.href.match(/\/projects\/([0-9a-f-]{36})/)?.[1] ?? null
      : null;
  const project = projectId ? viewer.state.projects.find((p) => p.id === projectId) ?? null : null;
  const [briefs, towers, projectBriefs] = await Promise.all([
    listBriefs(orgId, node.id),
    node.kind === "PROJECT"
      ? listPhases(orgId, node.id).then((all) => all.filter((ph) => viewer.authz.canAt("campaign:read", ph.path)))
      : Promise.resolve([]),
    project && viewer.authz.canAt("campaign:read", project.path)
      ? listBriefs(orgId, project.id)
      : Promise.resolve([] as BriefRow[]),
  ]);
  const hasSide = (node.kind === "PROJECT" && towers.length > 0) || (node.kind === "PHASE" && !!project);
  const towerBriefs = towers.length ? await briefCounts(orgId, towers.map((t) => t.id)) : new Map();
  const mayWrite = viewer.authz.canAt("campaign:create", node.path);
  const mayOpenLibrary = viewer.authz.can("asset:read") || viewer.authz.can("brand:read");

  return (
    <>
      <PageHead
        back={{ label: "Campaigns", href: "/dashboard/campaigns" }}
        title={
          <>
            Campaigns for <span className="em">{node.name}</span>
          </>
        }
        meta={
          <>
            {node.kind === "PHASE" && project ? (
              <>
                A tower of{" "}
                <Link href={`/dashboard/campaigns/${project.id}`} className="nodebriefs__up">
                  {project.name}
                </Link>
              </>
            ) : node.kind === "PHASE" ? (
              "This tower"
            ) : (
              "The whole project, every tower in it"
            )}
            {` · ${briefs.length} ${briefs.length === 1 ? "brief" : "briefs"}`}
          </>
        }
      />

      {(mayWrite || mayOpenLibrary) && (
        <div className="nodebriefs__top">
          {mayWrite && (
            <section className="card nodebriefs__start">
              <div className="card__head">
                <h2>{node.kind === "PROJECT" ? `Start a campaign for all of ${node.name}` : `Start a campaign for ${node.name}`}</h2>
              </div>
              {/* A refusal ("There is already a campaign called ...") shows
                  under the field and keeps the name typed into it. */}
              <KeptForm action={createBriefAction} messageAt="bottom">
                <input type="hidden" name="nodeId" value={node.id} />
                <div className="briefstart">
                  <input
                    type="text"
                    name="name"
                    required
                    maxLength={80}
                    placeholder="Diwali 2026"
                    aria-label="Campaign name"
                  />
                  <button type="submit" className="btn btn--ink">
                    Start the brief
                    <Plus size={14} />
                  </button>
                </div>
              </KeptForm>
            </section>
          )}

          {mayOpenLibrary && (
            <Link href={`/dashboard/library/${node.id}`} className="card assetlink" data-assets>
              <span className="empty__mark" style={{ width: 38, height: 38, flex: "none" }}>
                <ProjectIcon size={17} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="assetlink__title">
                  Assets Library
                  <ArrowUpRight size={14} />
                </span>
                <p className="sub" style={{ marginTop: 4 }}>
                  The approved pictures, plans and branding for {node.name}.
                </p>
              </span>
            </Link>
          )}
        </div>
      )}

      <div className={hasSide ? "split" : "stack"}>
        <div className="split__main">
            <section className="card">
              <div className="card__head">
                <h2>Briefs</h2>
                <span className="pill pill--quiet">{briefs.length}</span>
              </div>
              {briefs.length === 0 ? (
                <div className="empty" style={{ padding: "26px 20px" }}>
                  <div className="empty__mark">
                    <Campaign size={19} />
                  </div>
                  {mayWrite
                    ? "Nothing here yet. Name a campaign above to begin."
                    : "Nothing here yet."}
                </div>
              ) : (
                <div className="queue">
                  {briefs.map((brief) => {
                    const gaps = briefGaps(brief);
                    return (
                      <Link key={brief.id} href={`/dashboard/campaigns/brief/${brief.id}`} className="qi">
                        <span className="qi__mark qi__mark--info">
                          <Campaign size={15} />
                        </span>
                        <span className="qi__body">
                          <span className="qi__title">{brief.name}</span>
                          <p className="qi__why">
                            {briefLine(brief)}
                            {brief.updatedByName ? ` · ${brief.updatedByName}` : ""}
                            {` · ${onDate(brief.updatedAt)}`}
                          </p>
                        </span>
                        <span className="qi__tail">
                          {brief.status === "READY" ? (
                            <span className="pill pill--ok">
                              <span className="pill__dot" />
                              Ready
                            </span>
                          ) : (
                            <span className="pill pill--warn">
                              {gaps.length ? `${gaps.length} to fill in` : "Draft"}
                            </span>
                          )}
                          <span className="qi__do">
                            {mayWrite ? "Open the brief" : "Read the brief"}
                            <ArrowUpRight size={13} />
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
        </div>

        {node.kind === "PROJECT" && towers.length > 0 && (
          <aside className="split__side">
            <section className="card" aria-labelledby="towers-title" data-towers>
              <div className="card__head">
                <h2 id="towers-title">Towers</h2>
                <span className="pill pill--quiet">{towers.length}</span>
              </div>
              <div className="nodebriefs__list">
                {towers.map((t) => {
                  const count = towerBriefs.get(t.id)?.total ?? 0;
                  const clear = canAdvertise({ status: t.status, validTo: t.validTo, extendedUntil: t.extendedUntil, exemptionExpiresAt: null }).ok;
                  return (
                    <Link key={t.id} href={`/dashboard/campaigns/${t.id}`} className="nodebriefs__row">
                      <span className="nodebriefs__name">{t.name}</span>
                      <span className="nodebriefs__meta">
                        {count === 0 ? "No briefs" : `${count} ${count === 1 ? "brief" : "briefs"}`}
                      </span>
                      {!clear && (
                        <span className="pill pill--risk">
                          <span className="pill__dot" />
                          RERA blocked
                        </span>
                      )}
                      <ChevronRight size={14} />
                    </Link>
                  );
                })}
              </div>
            </section>
          </aside>
        )}

        {node.kind === "PHASE" && project && (
          <aside className="split__side">
            <section className="card" aria-labelledby="project-briefs-title" data-project-briefs>
              <div className="card__head">
                <h2 id="project-briefs-title">For all of {project.name}</h2>
                <span className="pill pill--quiet">{projectBriefs.length}</span>
              </div>
              <p className="sub" style={{ margin: "-6px 0 10px" }}>These run for {node.name} too.</p>
              <div className="nodebriefs__list">
                {projectBriefs.map((b) => (
                  <Link key={b.id} href={`/dashboard/campaigns/brief/${b.id}`} className="nodebriefs__row">
                    <span className="nodebriefs__name">{b.name}</span>
                    <span className={`pill ${b.status === "READY" ? "pill--ok" : "pill--warn"}`}>
                      {b.status === "READY" && <span className="pill__dot" />}
                      {b.status === "READY" ? "Ready" : "Draft"}
                    </span>
                    <ChevronRight size={14} />
                  </Link>
                ))}
                <Link href={`/dashboard/campaigns/${project.id}`} className="nodebriefs__all">
                  {projectBriefs.length === 0 ? `Start one for all of ${project.name}` : `Open ${project.name}'s campaigns`}
                  <ArrowUpRight size={13} />
                </Link>
              </div>
            </section>
          </aside>
        )}
      </div>
    </>
  );
}
