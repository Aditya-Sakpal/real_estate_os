import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { libraryOverview } from "@/lib/asset";
import { loadBrand } from "@/lib/brand";
import { orgRoot } from "@/lib/scope-nodes";
import { brandGaps } from "@/lib/brand-rules";
import { ArrowUpRight, Campaign, Mark, Project as ProjectIcon } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";

/**
 * The library, whole.
 *
 * It used to be reachable only by drilling into a campaign and then into a
 * project, and each node had a page that showed what it inherited from above
 * and nothing that sat below. There was no single place that showed
 * everything a developer owns: to see all the floor plans you visited every
 * tower in turn, which is the opposite of the point.
 *
 * Resolution walks upward because that is the question a generator asks,
 * "what may I build a Tower C ad from". A person browsing asks the other
 * question, "what do we have", and this page answers that one.
 */
export default async function LibraryPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  const mayAssets = viewer.authz.can("asset:read");
  const mayBrand = viewer.authz.can("brand:read");
  // The price approver holds this and no asset key, and the tree below is the
  // only way to reach the configurations it has to sign off.
  const mayUnits = viewer.authz.can("unit:read");
  if (!mayAssets && !mayBrand && !mayUnits && !viewer.authz.can("campaign:read")) redirect("/dashboard");

  const orgId = viewer.state.org.id;
  const [overview, brand] = await Promise.all([
    // The projects the shell already narrowed to this person's reach.
    mayAssets || mayUnits
      ? libraryOverview(orgId).then((all) => all.filter((p) => viewer.state.projects.some((q) => q.id === p.id)))
      : [],
    // The kit hangs off the org root, which is a node rather than a column on
    // the organisation.
    mayBrand
      ? orgRoot(orgId).then((root) => (root ? loadBrand(orgId, root.id) : null))
      : null,
  ]);
  const brandGapCount = brand
    ? brandGaps(brand.resolved, brand.resolvedFiles.map((f) => f.role)).length
    : 0;

  const totals = overview.reduce(
    (acc, p) => {
      acc.assets += p.assets + p.phases.reduce((n, ph) => n + ph.assets, 0);
      acc.approved += p.approved + p.phases.reduce((n, ph) => n + ph.approved, 0);
      return acc;
    },
    { assets: 0, approved: 0 },
  );

  return (
    <>
      <PageHead
        title={
          <>
            Everything a creative is <span className="em">made</span> of
          </>
        }
        meta="The marks, the renders and plans, and what each tower sells."
      />

      <div className="libtop">
      {mayBrand && (
        <Link href="/dashboard/library/branding" className="card assetlink" data-branding>
          <span className="empty__mark" style={{ width: 38, height: 38, flex: "none" }}>
            <Mark size={17} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="assetlink__title">
              Branding
              <ArrowUpRight size={14} />
            </span>
            <p className="sub" style={{ marginTop: 4 }}>
              Logo, colours, contact details and the disclaimer on every ad.
            </p>
          </span>
          {brandGapCount > 0 && (
            <span className="pill pill--warn">{brandGapCount} to fill in</span>
          )}
        </Link>
      )}

      {viewer.authz.can("campaign:read") && (
        <Link href="/dashboard/library/market" className="card assetlink" data-market>
          <span className="empty__mark" style={{ width: 38, height: 38, flex: "none" }}>
            <Campaign size={17} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="assetlink__title">
              Competitor ads
              <ArrowUpRight size={14} />
            </span>
            <p className="sub" style={{ marginTop: 4 }}>
              Ads your team saved, and Sales Desk&apos;s library for your cities.
            </p>
          </span>
        </Link>
      )}
      </div>

      {(mayAssets || mayUnits) && (
        <section className="card">
          <div className="card__head">
            <h2>Projects and towers</h2>
            {mayAssets && (
              <span className="pill pill--quiet">
                {totals.approved} of {totals.assets} approved
              </span>
            )}
          </div>

          {overview.length === 0 ? (
            <div className="empty" style={{ padding: "26px 20px" }}>
              <div className="empty__mark">
                <ProjectIcon size={19} />
              </div>
              Add a project before there is anything to hold.
            </div>
          ) : (
            <div className="libtree">
              {overview.map((project) => (
                <div key={project.id} className="libproject">
                  <Link href={`/dashboard/library/${project.id}`} className="libnode">
                    <span className="libnode__name">
                      <strong>{project.name}</strong>
                      <small>{project.city ?? "Project"}</small>
                    </span>
                    {mayAssets && (
                      <Counts total={project.assets} approved={project.approved} />
                    )}
                  </Link>

                  {project.phases.map((phase) => (
                    <Link
                      key={phase.id}
                      href={`/dashboard/library/${phase.id}`}
                      className="libnode libnode--phase"
                    >
                      <span className="libnode__name">{phase.name}</span>
                      <span className="libnode__counts">
                        {/* Configurations hang off a tower and nowhere else,
                            so only a tower row carries this. An empty one is
                            worth saying: it is how somebody finds out the
                            question is being asked. */}
                        {mayUnits && <UnitCount {...phase} />}
                        {mayAssets && (
                          <Counts total={phase.assets} approved={phase.approved} />
                        )}
                      </span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * What a tower sells, in one pill.
 *
 * "No configurations" is shown rather than nothing at all, because a blank is
 * how the whole thing stayed invisible: somebody looking for where to record
 * a 2 BHK had no sign that the question existed.
 */
function UnitCount({ units, unitsApproved }: { units: number; unitsApproved: number }) {
  if (units === 0) return <span className="pill pill--quiet">No configurations</span>;
  const word = units === 1 ? "configuration" : "configurations";
  if (unitsApproved === units) {
    return (
      <span className="pill pill--ok">
        <span className="pill__dot" />
        {units} {word}
      </span>
    );
  }
  return (
    <span className="pill pill--warn">
      {unitsApproved} of {units} {word} approved
    </span>
  );
}

/**
 * What is filed here, in one pill.
 *
 * It used to say "4 approved" and leave the noun to context. With a
 * configurations pill beside it that stopped working: two green pills on one
 * row, neither saying what it counted. Both now name the thing and read the
 * same way round.
 */
function Counts({ total, approved }: { total: number; approved: number }) {
  if (total === 0) return <span className="pill pill--quiet">No assets</span>;
  const word = total === 1 ? "asset" : "assets";
  if (approved === total) {
    return (
      <span className="pill pill--ok">
        <span className="pill__dot" />
        {total} {word}
      </span>
    );
  }
  return (
    <span className="pill pill--warn">
      {approved} of {total} {word} approved
    </span>
  );
}
