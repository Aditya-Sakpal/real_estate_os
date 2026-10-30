import Link from "next/link";
import { MediaThumb } from "@/components/MediaThumb";
import { redirect, notFound } from "next/navigation";
import { inReach } from "@/lib/grant-rules";
import { getViewer } from "@/lib/console";
import { approvedAssets as approvedHere, loadLibrary, type AssetRow } from "@/lib/asset";
import { linkedTo } from "@/lib/linked";
import {
  assetState,
  categoriesFor,
  categoryDef,
  categoryFitsNode,
  constructionIsStale,
  isAssetVideo,
  isPerUnit,
  istDay,
  ASSET_CATEGORIES,
  ASSET_TYPES,
} from "@/lib/asset-rules";
import { approvedUnits as unitsHere, loadUnits, type UnitTypeRow } from "@/lib/unit";
import { areaLine, areaText, fromSqft, priceFor, takesPlot, unitState, ROOMS, UNIT_CONFIGS } from "@/lib/unit-rules";
import { approveAssetAction, removeAssetAction, renameAssetAction } from "@/app/actions/asset";
import {
  approveUnitTypeAction,
  removeUnitTypeAction,
  reviseUnitTypeAction,
  tagAssetAction,
} from "@/app/actions/unit";
import UploadPanel from "./UploadPanel";
import CopyPanel, { type TargetGroup } from "./CopyPanel";
import UnitPanel from "./UnitPanel";
import UnitCopyPanel from "./UnitCopyPanel";
import { onDate } from "@/lib/team";
import { listScopeNodes, type ScopeNode } from "@/lib/scope-nodes";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { KeptForm } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";
import { ArrowLeft, Check } from "@/components/icons";
import "./library.css";

/**
 * Where something could be copied, grouped under its project.
 *
 * Anywhere in the organisation the person may act, not just this project: a
 * clubhouse render is as useful to the next launch as to the next tower. A
 * project is offered as itself ("whole project") and its towers beneath it.
 */
function targetGroups(tree: readonly ScopeNode[], keep: (n: ScopeNode) => boolean): TargetGroup[] {
  return tree
    .filter((p) => p.kind === "PROJECT")
    .map((p) => ({
      project: p.name,
      options: tree
        .filter((n) => n.id === p.id || (n.kind === "PHASE" && n.path.startsWith(`${p.path}.`)))
        .filter(keep)
        .map((n) => ({ id: n.id, name: n.id === p.id ? `${n.name}, whole project` : n.name })),
    }))
    .filter((g) => g.options.length > 0);
}

/**
 * The Approved Asset Library for one node.
 *
 * What a creative may be built from, and nothing else can be. An asset whose
 * current bytes carry no approval shows as unapproved: it is in the library,
 * and it is not available to a generator.
 *
 * Assets are a union down the tree rather than an override, so a tower shows
 * its own floor plans and the project's site plan together. Two categories do
 * not travel at all, and the catalog says why.
 */
export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ nodeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  // Two things live on this page now. A finance approver holds the price key
  // and no asset key at all, and has to be able to reach the configurations
  // it is being asked to approve.
  if (!viewer.authz.can("asset:read") && !viewer.authz.can("unit:read")) redirect("/dashboard");

  const { nodeId } = await params;
  // Only a message this app signed is shown; anything else in the address
  // is somebody else's words and is not printed.
  const query = await searchParams;
  const error = readFlash(query, "error");
  const catParam = Array.isArray(query.cat) ? query.cat[0] : query.cat;

  const orgId = viewer.state.org.id;
  const library = await loadLibrary(orgId, nodeId);
  // Holding a key somewhere is not holding it here: a node outside the
  // viewer's reach (a tower of theirs, or the project above it) is not found.
  if (!library || !inReach(library.node.path, [...viewer.authz.scopesFor("asset:read"), ...viewer.authz.scopesFor("unit:read")])) notFound();

  const { node } = library;
  const mayRead = viewer.authz.canAt("asset:read", node.path);
  const mayManage = viewer.authz.canAt("asset:manage", node.path);
  const mayApprove = viewer.authz.canAt("asset:approve", node.path);

  // A channel partner's project added from a developer: the developer's
  // approved pictures and configurations, shown beside the partner's own
  // pictures and never editable here.
  const linked = await linkedTo(orgId, node.id);
  const fromDeveloper = linked
    ? (await approvedHere(orgId, node.id)).filter((a) => a.sourceOrgId).map((a) => ({ ...a, nodeName: linked.developer }))
    : [];
  const developerAsset = new Set(fromDeveloper.map((a) => a.id));
  const resolved = [...fromDeveloper, ...library.resolved];

  // A configuration belongs to one tower, so the section only exists on a
  // phase. At a project the towers underneath hold their own.
  const isTower = node.kind === "PHASE";
  const maySeeUnits = viewer.authz.canAt("unit:read", node.path);
  const mayManageUnits = isTower && !linked && viewer.authz.canAt("unit:manage", node.path);
  const mayApproveUnits = isTower && !linked && viewer.authz.canAt("brain.price:approve", node.path);

  const unitView = !maySeeUnits
    ? null
    : linked
      ? await unitsHere(orgId, node.id).then(({ units, basePsf }) => ({
          // Placed on this tower, each approved by the developer.
          units: units.map((u) => ({ ...u, nodeId: node.id })),
          basePsf,
          approvals: units.map((u) => ({ unitTypeId: u.id, sha256: u.sha256, byName: linked.developer, at: "" })),
        }))
      : await loadUnits(orgId, node.id);
  const units = unitView?.units ?? [];
  const ownUnits = units.filter((u) => u.nodeId === node.id);
  const basePsf = unitView?.basePsf ?? null;
  const unitOf = (u: UnitTypeRow) => unitState(u, unitView?.approvals ?? []);

  // Two lists, not one. A phase may HOLD floor plans and progress photos; it
  // also RESOLVES the project's site plan and location map, which it may not
  // hold. Listing only what it can hold hid everything it inherits, which is
  // most of what a creative for a tower is actually built from.
  const uploadable = new Set(categoriesFor(node.kind).map((c) => c.key));
  const categories = ASSET_CATEGORIES.filter(
    (c) => uploadable.has(c.key) || resolved.some((a) => a.category === c.key),
  );
  const state = (a: AssetRow) =>
    developerAsset.has(a.id)
      ? { approved: true, stale: false, byName: linked?.developer ?? null, at: null }
      : assetState(
          { id: a.id, category: a.category, sha256: a.sha256, isRender: a.isRender,
            capturedOn: a.capturedOn, path: a.path },
          library.approvals,
        );

  const approvedCount = resolved.filter((a) => state(a).approved).length;

  // Where these could legally land, and where this person may add. A floor
  // plan is per tower and a site plan is per project, so a node that cannot
  // hold any of what is here is not offered, and neither is one the person
  // holds no key on: a control that would only ever be refused should not
  // exist. The action asks the same question again at the target.
  const tree = mayManage || mayManageUnits ? await listScopeNodes(orgId) : [];
  const targets = targetGroups(
    tree,
    (n) =>
      n.id !== node.id &&
      library.own.some((a) => categoryFitsNode(a.category, n.kind)) &&
      viewer.authz.canAt("asset:manage", n.path),
  );

  // Only towers, because that is the only place a configuration can land.
  const unitTargets = targetGroups(
    tree,
    (n) => n.id !== node.id && n.kind === "PHASE" && viewer.authz.canAt("unit:manage", n.path),
  );

  // The pictures, all in one grid in catalog order, each carrying its kind.
  // One card per kind left a full-width card around one tile, nine times.
  const countOf = (key: string) => resolved.filter((a) => a.category === key).length;
  const active = categories.find((c) => c.key === catParam)?.key ?? null;
  const order = new Map(categories.map((c, i) => [c.key, i]));
  const shown = resolved
    .filter((a) => !active || a.category === active)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (order.get(x.a.category) ?? 99) - (order.get(y.a.category) ?? 99) || x.i - y.i)
    .map(({ a }) => a);
  const here = `/dashboard/library/${node.id}`;

  const showUnits = isTower && maySeeUnits;
  const showUpload = mayRead && mayManage;
  // A tower takes its project's site plan, location map and nearby places, which are uploaded on the project.
  const projectAbove = isTower ? tree.find((n) => n.kind === "PROJECT" && node.path.startsWith(`${n.path}.`)) ?? null : null;
  const projectUpload = projectAbove && viewer.authz.canAt("asset:manage", projectAbove.path) ? projectAbove : null;
  const mayCopyUnits = mayManageUnits && ownUnits.length > 0 && unitTargets.length > 0;
  const mayCopyAssets = mayRead && mayManage && library.own.length > 0 && targets.length > 0;
  const approvedUnits = units.filter((u) => unitOf(u).approved).length;

  return (
    <div className="lib">
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href="/dashboard/library" className="backlink" data-back>
            <ArrowLeft size={13} />
            Assets Library
          </Link>
          <h1 style={{ marginTop: 4 }}>
            <span className="em">{node.name}</span>
          </h1>
        </div>
        <div className="pagehead__acts">
          {units.length > 0 && (
            <span className={`pill ${approvedUnits === units.length ? "pill--ok" : "pill--quiet"}`}>
              {approvedUnits} of {units.length} configurations approved
            </span>
          )}
          {mayRead && resolved.length > 0 && (
            <span
              className={`pill ${approvedCount === resolved.length ? "pill--ok" : "pill--quiet"}`}
            >
              {approvedCount} of {resolved.length} pictures approved
            </span>
          )}
        </div>
      </div>

      <Flash text={error} name="error" tone="risk" style={{ marginBottom: 16 }} />

      {(showUnits || showUpload) && (
        <div className={`lib-top${showUnits && showUpload ? " lib-top--two" : ""}`}>
          {showUnits && (
            <section className="card lib-units">
              <div className="card__head">
                <h2>What this tower sells</h2>
                <span className="pill pill--quiet">{ownUnits.length}</span>
              </div>

              {ownUnits.length > 0 ? (
                <div className="unitgrid">
                  {ownUnits.map((u) => (
                    <UnitCard
                      key={u.id}
                      unit={u}
                      nodeId={node.id}
                      basePsf={basePsf}
                      state={unitOf(u)}
                      mayManage={mayManageUnits}
                      mayApprove={mayApproveUnits}
                    />
                  ))}
                </div>
              ) : (
                <p className="refgroup__none">Nothing recorded yet.</p>
              )}

              {(mayManageUnits || mayCopyUnits) && (
                <div className="lib-tools">
                  {mayManageUnits && (
                    <details className="lib-tool" open={ownUnits.length === 0 || undefined}>
                      <summary>Record a configuration</summary>
                      <div className="lib-tool__body">
                        <UnitPanel
                          nodeId={node.id}
                          configs={UNIT_CONFIGS.map((c) => ({ key: c.key, label: c.label, plot: !!c.plot }))}
                          basePsf={basePsf}
                        />
                      </div>
                    </details>
                  )}
                  {mayCopyUnits && (
                    <details className="lib-tool">
                      <summary>Copy to another tower</summary>
                      <div className="lib-tool__body">
                        <p className="lib-tool__note">Copies arrive unapproved.</p>
                        <UnitCopyPanel
                          nodeId={node.id}
                          units={ownUnits.map((u) => ({
                            id: u.id,
                            label: u.label,
                            detail: priceLine(u, basePsf),
                            assets: u.assetCount,
                          }))}
                          targets={unitTargets}
                          mayBringPictures={viewer.authz.can("asset:manage")}
                        />
                      </div>
                    </details>
                  )}
                </div>
              )}
            </section>
          )}

          {showUpload && (
            <section className="card lib-add" id="add-pictures">
              <div className="card__head">
                <h2>Add pictures</h2>
              </div>
              <UploadPanel
                nodeId={node.id}
                categories={categoriesFor(node.kind).map((c) => ({
                  key: c.key,
                  label: c.label,
                  detail: c.detail,
                  dated: c.dated,
                  photographic: c.photographic,
                }))}
                accept={ASSET_TYPES.join(",")}
                today={istDay(new Date())}
              />
              {projectUpload && (
                <p className="lib-tool__note lib-add__elsewhere">
                  Site plan, location map and nearby places go on the project.{" "}
                  <Link href={`/dashboard/library/${projectUpload.id}#add-pictures`}>Add them to {projectUpload.name}</Link>
                </p>
              )}
              {mayCopyAssets && (
                <div className="lib-tools">
                  <details className="lib-tool">
                    <summary>Copy to another place</summary>
                    <div className="lib-tool__body">
                      <p className="lib-tool__note">Copies arrive unapproved.</p>
                      <CopyPanel
                        nodeId={node.id}
                        assets={library.own.map((a) => ({
                          id: a.id,
                          title: a.title ?? a.mediaName ?? "Untitled",
                          category: categoryDef(a.category)?.label ?? a.category,
                        }))}
                        targets={targets}
                      />
                    </div>
                  </details>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {mayRead && (
        <section className="card lib-pics">
          <div className="card__head">
            <h2>Pictures</h2>
            <span className="pill pill--quiet">{resolved.length}</span>
          </div>

          <div className="lib-bar">
            <nav className="lib-chips" aria-label="Filter by kind">
              <Link
                href={here}
                scroll={false}
                className={`lib-chip${active ? "" : " is-on"}`}
                aria-current={active ? undefined : "page"}
              >
                All <span className="lib-chip__n">{resolved.length}</span>
              </Link>
              {categories.map((c) => {
                const n = countOf(c.key);
                // A kind with nothing in it is shown, so the gap is visible,
                // and is not a link, because it would open an empty grid.
                if (n === 0) {
                  return (
                    <span key={c.key} className="lib-chip lib-chip--none">
                      {c.label} <span className="lib-chip__n">0</span>
                    </span>
                  );
                }
                return (
                  <Link
                    key={c.key}
                    href={`${here}?cat=${c.key}`}
                    scroll={false}
                    className={`lib-chip${active === c.key ? " is-on" : ""}`}
                    aria-current={active === c.key ? "page" : undefined}
                  >
                    {c.label} <span className="lib-chip__n">{n}</span>
                  </Link>
                );
              })}
            </nav>

          </div>

          {shown.length > 0 ? (
            <div className="refgrid lib-grid">
              {shown.map((a) => (
                <AssetTile
                  key={a.id}
                  asset={a}
                  node={node}
                  state={state(a)}
                  mayApprove={mayApprove}
                  mayManage={mayManage && a.nodeId === node.id}
                  units={ownUnits}
                />
              ))}
            </div>
          ) : (
            <div className="lib-empty">
              {active
                ? uploadable.has(active)
                  ? "Nothing here yet."
                  : "Nothing filed on the project above."
                : "No pictures yet."}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Indian grouping, and rupees rather than paise. Nobody advertises a paisa. */
const rupees = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;

const area = (n: number) => `${Number(n.toFixed(2)).toLocaleString("en-IN")} sq ft`;

/** One line naming the area and what it starts at, for a chooser or a summary. */
function priceLine(unit: UnitTypeRow, basePsf: number | null): string {
  const price = priceFor(unit, basePsf);
  return price === null ? areaLine(unit) : `${areaLine(unit)}, from ${rupees(price)}`;
}

/**
 * One configuration, its numbers, and whether they may be advertised.
 *
 * The configuration itself is not editable. Turning a 2 BHK into a 3 BHK is a
 * different product rather than a correction, and an edit would leave an
 * approval attached to something nobody approved. The numbers are editable,
 * as a version: the old ones stay with their approval, so what January's
 * creative was cleared against is still readable.
 */
function UnitCard({
  unit,
  nodeId,
  basePsf,
  state,
  mayManage,
  mayApprove,
}: {
  unit: UnitTypeRow;
  nodeId: string;
  basePsf: number | null;
  state: { approved: boolean; stale: boolean; byName: string | null; at: string | null };
  mayManage: boolean;
  mayApprove: boolean;
}) {
  const price = priceFor(unit, basePsf);

  return (
    <article className="unitcard" data-unit={unit.id}>
      <div className="unitcard__head">
        <strong>{unit.label}</strong>
        <span className="assetpills">
          {state.approved ? (
            <span className="pill pill--ok" data-unit-approved={unit.id}>
              <span className="pill__dot" />
              Approved{state.byName ? ` by ${state.byName}` : ""}
            </span>
          ) : state.stale ? (
            <span className="pill pill--warn">Changed since approval</span>
          ) : (
            <span className="pill pill--quiet">Not approved</span>
          )}
          {unit.versionCount > 1 && (
            <span className="pill pill--quiet">Version {unit.version}</span>
          )}
          {/* What a reel for this configuration has to draw on. A tower that
              sells a 2 BHK and holds no picture of one is the gap the whole
              tag exists to make visible. */}
          <span className={`pill ${unit.assetCount ? "pill--quiet" : "pill--warn"}`}>
            {unit.assetCount === 0
              ? "No pictures"
              : unit.assetCount === 1
                ? "1 picture"
                : `${unit.assetCount} pictures`}
          </span>
        </span>
      </div>

      <dl className="unitfacts">
        {unit.config !== "PLOT" && (
          <div>
            <dt>Carpet</dt>
            <dd>{area(unit.carpetAreaSqft)}</dd>
          </div>
        )}
        {unit.plotAreaSqft !== null && (
          <div>
            <dt>Plot</dt>
            <dd>{areaText(unit.plotAreaSqft, unit.areaUnit)}</dd>
          </div>
        )}
        {unit.balconyAreaSqft !== null && (
          <div>
            <dt>Balcony</dt>
            <dd>{area(unit.balconyAreaSqft)}</dd>
          </div>
        )}
        <div>
          <dt>From</dt>
          <dd>{price === null ? "No price yet" : rupees(price)}</dd>
        </div>
      </dl>

      {(mayManage || mayApprove) && (
        <div className="unitacts">
          {mayApprove && !state.approved && (
            <form action={approveUnitTypeAction}>
              <input type="hidden" name="nodeId" value={nodeId} />
              <input type="hidden" name="unitTypeId" value={unit.id} />
              <button
                type="submit"
                className="btn btn--ghost btn--sm"
                data-approve-unit={unit.id}
              >
                Approve
                <Check size={12} />
              </button>
            </form>
          )}

          {/* Folded away, because the numbers are already on the card above
              and three unlabelled boxes under them is a puzzle rather than a
              form. Opening it is how somebody says they mean to change one. */}
          {mayManage && (
            <details className="unitrevise">
              <summary>Change the numbers</summary>
              <KeptForm action={reviseUnitTypeAction} messageAt="bottom">
                <input type="hidden" name="nodeId" value={nodeId} />
                <input type="hidden" name="unitTypeId" value={unit.id} />
                {unit.config !== "PLOT" && (
                  <label className="uploader__field">
                    <span>Carpet, sq ft</span>
                    <input
                      type="text"
                      name="carpetAreaSqft"
                      defaultValue={unit.carpetAreaSqft}
                      inputMode="decimal"
                      data-revise-carpet={unit.id}
                    />
                  </label>
                )}
                {takesPlot(unit.config) && (
                  <>
                    <label className="uploader__field">
                      <span>Plot area</span>
                      <input
                        type="text"
                        name="plotArea"
                        defaultValue={unit.plotAreaSqft !== null ? fromSqft(unit.plotAreaSqft, unit.areaUnit) : ""}
                        inputMode="decimal"
                        required={unit.config === "PLOT"}
                      />
                    </label>
                    <label className="uploader__field">
                      <span>Measured in</span>
                      <select name="areaUnit" defaultValue={unit.areaUnit ?? "SQYD"}>
                        <option value="SQFT">sq ft</option>
                        <option value="SQYD">sq yd</option>
                        <option value="SQM">sq m</option>
                      </select>
                    </label>
                  </>
                )}
                {takesPlot(unit.config) && unit.config !== "PLOT" && (
                  <label className="uploader__field">
                    <span>Rate is per sq ft of</span>
                    <select name="priceBasis" defaultValue={unit.priceBasis ?? "CARPET"}>
                      <option value="CARPET">Carpet area</option>
                      <option value="PLOT">Plot area</option>
                    </select>
                  </label>
                )}
                {unit.config !== "PLOT" && (
                  <label className="uploader__field">
                    <span>Balcony, sq ft</span>
                    <input
                      type="text"
                      name="balconyAreaSqft"
                      defaultValue={unit.balconyAreaSqft ?? ""}
                      inputMode="decimal"
                    />
                  </label>
                )}
                <label className="uploader__field">
                  <span>Starting price</span>
                  <input
                    type="text"
                    name="startingPrice"
                    defaultValue={unit.startingPrice ?? ""}
                    inputMode="numeric"
                    placeholder={basePsf ? "From the rate" : "Price"}
                    data-revise-price={unit.id}
                  />
                </label>
                <button type="submit" className="btn btn--ghost btn--sm" data-revise={unit.id}>
                  Save as a new version
                </button>
              </KeptForm>
            </details>
          )}

          {/* Pictures filed under a configuration hold it in place, so with
              any tagged the removal is not offered as a live button: it
              would only ever be refused. */}
          {mayManage && unit.assetCount > 0 && (
            <small className="hint" data-remove-unit-held={unit.id}>
              {unit.assetCount === 1 ? "1 picture is" : `${unit.assetCount} pictures are`} filed
              under it. Set {unit.assetCount === 1 ? "it" : "them"} to Any configuration to
              remove it.
            </small>
          )}
          {mayManage && unit.assetCount === 0 && (
            <ConfirmAction
              label="Remove"
              title={`Remove ${unit.label}?`}
              body={
                <p>
                  {unit.label} is taken off this tower, with every version of its numbers and
                  their approvals.
                </p>
              }
              confirmLabel={`Remove ${unit.label}`}
              action={removeUnitTypeAction}
              fields={{ nodeId, unitTypeId: unit.id }}
              tone="risk"
              testId={`remove-unit-${unit.id}`}
            />
          )}
        </div>
      )}
    </article>
  );
}

function AssetTile({
  asset,
  node,
  state,
  mayApprove,
  mayManage,
  units,
}: {
  asset: AssetRow;
  node: { id: string; name: string };
  state: { approved: boolean; stale: boolean; byName: string | null; at: string | null };
  mayApprove: boolean;
  mayManage: boolean;
  units: UnitTypeRow[];
}) {
  const src = `/dashboard/library/${node.id}/file/${asset.id}`;
  const mb = asset.mediaBytes / (1024 * 1024);
  const inherited = asset.nodeId !== node.id || !!asset.sourceOrgId;
  const stalePhoto = asset.category === "CONSTRUCTION" && constructionIsStale(asset.capturedOn);
  // A progress photo is a photograph by nature, whatever an older row says.
  const render = asset.isRender && !categoryDef(asset.category)?.photographic;
  const name = asset.title ?? asset.mediaName ?? "this asset";

  return (
    <figure className="reftile">
      <div className="reftile__media">
        <span className="lib-cat">{categoryDef(asset.category)?.label ?? asset.category}</span>
        {isAssetVideo(asset.mediaType) ? (
          // The 720p preview plays and its still shows first; until they are
          // made, the original does both.
          <video src={`${src}?v=preview`} poster={`${src}?v=poster`} controls preload="metadata" playsInline />
        ) : (
          <a href={src} target="_blank" rel="noreferrer">
            <MediaThumb src={src} video={false} alt={asset.title ?? categoryDef(asset.category)?.label ?? "Asset"} />
          </a>
        )}
      </div>

      <figcaption className="reftile__foot assetfoot">
        <span className="reftile__words">
          <strong className={asset.title ? undefined : "reftile__untitled"}>
            {asset.title ?? asset.mediaName ?? "Untitled"}
          </strong>
          <small>
            {render ? "Render" : "Photograph"}
            {mb >= 0.1 ? ` · ${mb.toFixed(1)} MB` : ""}
            {asset.capturedOn ? ` · ${onDate(asset.capturedOn)}` : ""}
            {inherited ? ` · from ${asset.nodeName}` : ""}
          </small>

          {(asset.unitLabel || asset.room) && (
            <span className="assetpills">
              {asset.unitLabel && (
                <span className="pill pill--quiet" data-unit-tag>
                  {asset.unitLabel}
                </span>
              )}
              {asset.room && <span className="pill pill--quiet">{asset.room}</span>}
            </span>
          )}

          <span className="assetpills">
            {state.approved ? (
              <span className="pill pill--ok">
                <span className="pill__dot" />
                Approved{state.byName ? ` by ${state.byName}` : ""}
              </span>
            ) : state.stale ? (
              <span className="pill pill--warn">Changed since approval</span>
            ) : (
              <span className="pill pill--quiet">Not approved</span>
            )}
            {stalePhoto && <span className="pill pill--warn">Over 90 days old</span>}
          </span>
        </span>
      </figcaption>

      {(mayApprove || mayManage) && !inherited && (
        <div className="assetacts">
          {mayApprove && !state.approved && (
            <form action={approveAssetAction}>
              <input type="hidden" name="nodeId" value={node.id} />
              <input type="hidden" name="assetId" value={asset.id} />
              <button type="submit" className="btn btn--ghost btn--sm" data-approve={asset.id}>
                Approve
                <Check size={12} />
              </button>
            </form>
          )}
          {/* Closed until asked for: a picture in the library opens as it
              is, and changing it is a decision. */}
          {mayManage && (
            <details className="lib-edit">
              <summary>Edit</summary>
              <div className="lib-edit__body">
                {/* Only where the picture is of one flat rather than of the
                    building, and only once the tower has configurations to
                    name. A picker with nothing in it is a control that does
                    nothing. */}
                {isPerUnit(asset.category) && units.length > 0 && (
                  <KeptForm action={tagAssetAction} className="assettag" messageAt="bottom">
                    <input type="hidden" name="nodeId" value={node.id} />
                    <input type="hidden" name="assetId" value={asset.id} />
                    <select
                      name="unitTypeId"
                      defaultValue={asset.unitTypeId ?? ""}
                      aria-label="Configuration"
                    >
                      <option value="">Any configuration</option>
                      {units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                    <select name="room" defaultValue={asset.room ?? ""} aria-label="Room">
                      <option value="">Any room</option>
                      {ROOMS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="reftile__remove" data-tag={asset.id}>
                      Save
                    </button>
                  </KeptForm>
                )}

                <KeptForm action={renameAssetAction} className="assetrename" messageAt="bottom">
                  <input type="hidden" name="nodeId" value={node.id} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  <input
                    type="text"
                    name="title"
                    defaultValue={asset.title ?? ""}
                    maxLength={120}
                    placeholder="Name it"
                    aria-label="Title"
                  />
                  <button type="submit" className="reftile__remove" data-rename={asset.id}>
                    Save
                  </button>
                </KeptForm>

                <ConfirmAction
                  label="Remove"
                  title={`Remove ${name} from the library?`}
                  body={
                    <p>
                      The file and every earlier version of it are deleted from {node.name}, with
                      their approvals. New creatives can no longer use it.
                    </p>
                  }
                  confirmLabel="Remove it"
                  action={removeAssetAction}
                  fields={{ nodeId: node.id, assetId: asset.id }}
                  tone="risk"
                  testId={`remove-${asset.id}`}
                />
              </div>
            </details>
          )}
        </div>
      )}
    </figure>
  );
}
