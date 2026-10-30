import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getViewer } from "@/lib/console";
import { inReach } from "@/lib/grant-rules";
import { sellsForOthers } from "@/lib/mandate-rules";
import { loadBrand, type BrandFile } from "@/lib/brand";
import { listScopeNodes, orgRoot } from "@/lib/scope-nodes";
import {
  acceptForRole,
  brandGaps,
  showPhone,
  BRAND_FILE_ROLES,
  TYPEFACE_LANGUAGES,
  type BrandFileRole,
  type BrandKit,
} from "@/lib/brand-rules";
import { removeBrandFileAction } from "@/app/actions/brand";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { ConfirmAction } from "@/components/ConfirmAction";
import { BrandEditor, BrandFields, BrandNote, BrandSave, MarkPicker, MarkStatusBadge } from "./BrandForm";
import { NodePicker } from "./NodePicker";
import { ArrowLeft } from "@/components/icons";
import "./branding.css";

const FORM = "brandform";

/**
 * The brand kit.
 *
 * Said once on a node and inherited downward, so the organisation's logo and
 * phone number reach every project without being retyped. A value shown with
 * the node it came from is inherited; a value on this node overrides it.
 */
export default async function BrandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("brand:read")) redirect("/dashboard");

  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const orgId = viewer.state.org.id;
  // Only messages this app signed are shown; anything else in the address
  // is somebody else's words and is not printed.
  const error = readFlash(q, "error");
  const notice = readFlash(q, "notice");

  const root = await orgRoot(orgId);
  if (!root) notFound();
  const nodeId = one(q.node) || root.id;

  // The kit is read where the viewer holds the key, and on the nodes above
  // that it inherits from; a node beside theirs is not found.
  const reach = viewer.authz.scopesFor("brand:read");
  const brand = await loadBrand(orgId, nodeId);
  if (!brand || !inReach(brand.node.path, reach)) notFound();

  const tree = await listScopeNodes(orgId);
  const nodes = tree.filter((n) => inReach(n.path, reach));
  const mayWrite = viewer.authz.canAt("brand:manage", brand.node.path);

  const bare = (kit: BrandKit) =>
    Object.values(kit).every((v) => v === null || (Array.isArray(v) && !v.length));
  const ownIsEmpty = bare(brand.own) && brand.ownFiles.length === 0;
  // Inherited counts as something to read. A project that takes the whole kit
  // from the organisation opened straight into a blank override form, which
  // reads as "nothing is set here" when in fact everything is.
  const nothingToRead = ownIsEmpty && bare(brand.resolved) && brand.resolvedFiles.length === 0;

  // A record that exists opens read-only and editing is a decision. A node
  // with nothing to show, inherited or its own, has nothing to read.
  const editing = mayWrite && (one(q.edit) === "1" || nothingToRead);

  const gaps = brandGaps(
    brand.resolved,
    brand.resolvedFiles.map((f) => f.role),
  );

  const fileFor = (role: BrandFileRole) =>
    brand.resolvedFiles.find((f) => f.role === role);

  // Grouped by kind. A tower carries its project's name, because "Phase 1"
  // means nothing until you know whose; a city named twice carries its
  // company's.
  const byPath = new Map(tree.map((n) => [n.path, n]));
  const above = (path: string, kind: string) => {
    for (let p = path; p.includes("."); ) {
      p = p.slice(0, p.lastIndexOf("."));
      const n = byPath.get(p);
      if (n?.kind === kind) return n.name;
    }
    return null;
  };
  const regionNames = nodes.filter((n) => n.kind === "REGION").map((n) => n.name);
  const labelOf = (n: (typeof nodes)[number]) => {
    if (n.kind === "PHASE") {
      const project = above(n.path, "PROJECT");
      return project ? `${project} · ${n.name}` : n.name;
    }
    if (n.kind === "REGION" && regionNames.filter((r) => r === n.name).length > 1) {
      const entity = above(n.path, "ENTITY");
      return entity ? `${n.name}, ${entity}` : n.name;
    }
    return n.name;
  };
  // A mandate firm or a channel partner files each developer it sells for as
  // an entity, and its own kit sits at the root above all of them.
  const seller = sellsForOthers(viewer.orgType);
  const GROUPS: [string, string][] = [
    ["ORG", seller ? "Your own brand" : "Organisation"],
    ["ENTITY", seller ? "Developers" : "Legal entities"],
    ["REGION", "Cities"],
    ["PROJECT", "Projects"],
    ["PHASE", "Towers"],
  ];
  const choices = GROUPS.map(([kind, label]) => ({
    label,
    nodes: nodes.filter((n) => n.kind === kind).map((n) => ({ id: n.id, name: labelOf(n) })),
  })).filter((g) => g.nodes.length > 0);

  // Rendered the same either way, so it is built once. The slots differ only
  // in whether they offer a picker, which they read from `editing`.
  const marks = (
    <section className="card bk-marks">
      <div className="card__head">
        <h2>Marks</h2>
      </div>

      <div className="brandfiles">
        {BRAND_FILE_ROLES.map((role) => (
          <FileSlot
            key={role.key}
            role={role}
            file={fileFor(role.key)}
            nodeId={brand.node.id}
            nodeName={brand.node.name}
            editing={editing}
          />
        ))}
      </div>
    </section>
  );

  const page = (
    <div className="bk">
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href="/dashboard/library" className="backlink" data-back>
            <ArrowLeft size={13} />
            Assets Library
          </Link>
          <h1 style={{ marginTop: 4 }}>
            Branding for <span className="em">{brand.node.name}</span>
          </h1>
        </div>

        <div className="pagehead__acts">
          {nodes.length > 1 && <NodePicker groups={choices} current={brand.node.id} />}
          {editing ? (
            // One primary action, and only one, and only while there is
            // something to save. There was a Done beside it that left the
            // form without saving, which put a quiet way to lose the work
            // next to the way to keep it.
            <BrandSave />
          ) : (
            mayWrite && (
              <Link
                href={`/dashboard/library/branding?node=${brand.node.id}&edit=1`}
                className="btn btn--ink"
                data-edit
              >
                Edit branding
              </Link>
            )
          )}
        </div>
      </div>

      <Flash text={error} name="error" tone="risk" style={{ marginBottom: 16 }} />
      <Flash text={notice} name="notice" tone="info" style={{ marginBottom: 16 }} />
      {editing && <BrandNote />}
      {!editing && gaps.length > 0 && (
        <div className="note note--warn bk-gaps">
          <strong>Still needed before a creative can be built</strong>
          <span className="bk-gaps__list">
            {gaps.map((g) => (
              <span key={g.key} className="pill pill--warn">
                {g.label}
              </span>
            ))}
          </span>
        </div>
      )}

      {editing ? (
        <>
          {/* Outside the form element, so each mark's Remove can be its own
              form behind its own confirmation. The pickers in it still
              belong to the one form by attribute. */}
          {marks}
          <BrandFields nodeId={brand.node.id}>
            <Fields kit={brand.own} editing brand={brand} />
          </BrandFields>
        </>
      ) : (
        <>
          {marks}
          <Fields kit={brand.resolved} editing={false} brand={brand} />
        </>
      )}
    </div>
  );

  // The Save control sits in the header and the fields sit down the page, so
  // the state they share is provided above both of them.
  return editing ? <BrandEditor formId={FORM}>{page}</BrandEditor> : page;
}

/**
 * The kit's words, laid out as a grid of fields with the label above each:
 * the identity beside the typeface and the disclaimer, then the contact
 * details across the width. Read-only and editing share the arrangement, so
 * pressing Edit turns each value into its box where it already sat.
 */
function Fields({
  kit,
  editing,
  brand,
}: {
  kit: BrandKit;
  editing: boolean;
  brand: NonNullable<Awaited<ReturnType<typeof loadBrand>>>;
}) {
  const from = (value: unknown, key: keyof BrandKit) => {
    if (editing) return null;
    const own = brand.own[key];
    const set = own !== null && own !== undefined && !(Array.isArray(own) && !own.length);
    if (set || value === null) return null;
    const source = brand.sources.filter((s) => s.path !== brand.node.path).at(-1);
    return source ? `from ${source.name}` : null;
  };

  const grid = `fieldgrid${editing ? " bk-edit" : ""}`;

  return (
    <div className="pair bk-pair">
      <section className="card">
        <div className="card__head">
          <h2>Identity</h2>
        </div>
        <div className={grid}>
          <Row
            label="Tagline"
            wide={editing}
            from={from(kit.tagline, "tagline")}
          >
            {editing ? (
              <input
                type="text"
                name="tagline"
                defaultValue={kit.tagline ?? ""}
                maxLength={120}
                placeholder="Homes that hold their value"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.tagline} />
            )}
          </Row>

          <Row label="Brand colour" from={from(kit.colourPrimary, "colourPrimary")}>
            {editing ? (
              <input
                type="text"
                name="colourPrimary"
                defaultValue={kit.colourPrimary ?? ""}
                maxLength={7}
                placeholder="#1b3a86"
                className="formfield__input"
              />
            ) : (
              <Swatch hex={kit.colourPrimary} />
            )}
          </Row>

          <Row label="Accent colour" from={from(kit.colourAccent, "colourAccent")}>
            {editing ? (
              <input
                type="text"
                name="colourAccent"
                defaultValue={kit.colourAccent ?? ""}
                maxLength={7}
                placeholder="#d98324"
                className="formfield__input"
              />
            ) : (
              <Swatch hex={kit.colourAccent} />
            )}
          </Row>

          <Row
            label={editing ? "Smallest logo height, px" : "Smallest logo height"}
            from={from(kit.logoMinPx, "logoMinPx")}
          >
            {editing ? (
              <input
                type="text"
                name="logoMinPx"
                defaultValue={kit.logoMinPx ?? ""}
                maxLength={4}
                inputMode="numeric"
                placeholder="48"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.logoMinPx ? `${kit.logoMinPx} px` : null} />
            )}
          </Row>

          <Row
            label={editing ? "Clear space, x logo height" : "Clear space"}
            from={from(kit.logoClearRatio, "logoClearRatio")}
          >
            {editing ? (
              <input
                type="text"
                name="logoClearRatio"
                defaultValue={kit.logoClearRatio ?? ""}
                maxLength={4}
                inputMode="decimal"
                placeholder="0.5"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.logoClearRatio ? `${kit.logoClearRatio} x logo height` : null} />
            )}
          </Row>
        </div>
      </section>

      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>Typeface</h2>
          </div>
          <div className={grid}>
            <Row label="Name" from={from(kit.typefaceName, "typefaceName")}>
              {editing ? (
                <input
                  type="text"
                  name="typefaceName"
                  defaultValue={kit.typefaceName ?? ""}
                  maxLength={80}
                  placeholder="Figtree"
                  className="formfield__input"
                />
              ) : (
                <Value text={kit.typefaceName} />
              )}
            </Row>

            <Row
              label="Languages it can set"
              wide={editing}
              from={from(
                kit.typefaceLanguages.length ? kit.typefaceLanguages : null,
                "typefaceLanguages",
              )}
            >
              {editing ? (
                <div className="checkset bk-langs">
                  {TYPEFACE_LANGUAGES.map((l) => (
                    <label key={l} className="checkset__item">
                      <input
                        type="checkbox"
                        name="typefaceLanguages"
                        value={l}
                        defaultChecked={kit.typefaceLanguages.includes(l)}
                      />
                      <span>
                        <strong>{l}</strong>
                      </span>
                    </label>
                  ))}
                </div>
              ) : kit.typefaceLanguages.length ? (
                <span className="formfield__value chipline">
                  {kit.typefaceLanguages.map((l) => (
                    <span key={l} className="pill pill--quiet">
                      {l}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="formfield__unset">Not set</span>
              )}
            </Row>
          </div>
        </section>

        <section className="card">
          <div className="card__head">
            <h2>Disclaimer</h2>
          </div>
          <div className={grid}>
            <Row label="Printed on every creative" wide from={from(kit.disclaimer, "disclaimer")}>
              {editing ? (
                <textarea
                  name="disclaimer"
                  rows={3}
                  defaultValue={kit.disclaimer ?? ""}
                  placeholder="All images are artist's impressions. Terms and conditions apply."
                />
              ) : (
                <Value text={kit.disclaimer} />
              )}
            </Row>
          </div>
        </section>
      </div>

      <section className="card pair__wide">
        <div className="card__head">
          <h2>Contact</h2>
        </div>
        <div className={`${grid} bk-contact`}>
          <Row label="Sales phone" from={from(kit.salesPhone, "salesPhone")}>
            {editing ? (
              <input
                type="text"
                name="salesPhone"
                defaultValue={kit.salesPhone ?? ""}
                maxLength={20}
                inputMode="tel"
                placeholder="+91 98765 43210"
                className="formfield__input"
              />
            ) : (
              <Value text={showPhone(kit.salesPhone)} />
            )}
          </Row>

          <Row label="Sales email" from={from(kit.salesEmail, "salesEmail")}>
            {editing ? (
              <input
                type="text"
                name="salesEmail"
                defaultValue={kit.salesEmail ?? ""}
                maxLength={160}
                inputMode="email"
                placeholder="sales@yourcompany.in"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.salesEmail} />
            )}
          </Row>

          <Row label="Website" from={from(kit.website, "website")}>
            {editing ? (
              <input
                type="text"
                name="website"
                defaultValue={kit.website ?? ""}
                maxLength={300}
                placeholder="yourcompany.in"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.website} />
            )}
          </Row>

          <Row label="Privacy policy" from={from(kit.privacyUrl, "privacyUrl")}>
            {editing ? (
              <input
                type="text"
                name="privacyUrl"
                defaultValue={kit.privacyUrl ?? ""}
                maxLength={300}
                placeholder="yourcompany.in/privacy"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.privacyUrl} />
            )}
          </Row>

          <Row label="Instagram" from={from(kit.instagramUrl, "instagramUrl")}>
            {editing ? (
              <input
                type="text"
                name="instagram"
                defaultValue={kit.instagramUrl ?? ""}
                maxLength={300}
                placeholder="@yourbrand"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.instagramUrl} />
            )}
          </Row>

          <Row label="Facebook" from={from(kit.facebookUrl, "facebookUrl")}>
            {editing ? (
              <input
                type="text"
                name="facebook"
                defaultValue={kit.facebookUrl ?? ""}
                maxLength={300}
                placeholder="facebook.com/yourbrand"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.facebookUrl} />
            )}
          </Row>

          <Row label="YouTube" from={from(kit.youtubeUrl, "youtubeUrl")}>
            {editing ? (
              <input
                type="text"
                name="youtube"
                defaultValue={kit.youtubeUrl ?? ""}
                maxLength={300}
                placeholder="@yourbrand"
                className="formfield__input"
              />
            ) : (
              <Value text={kit.youtubeUrl} />
            )}
          </Row>

          <Row
            label={editing ? "Sales office, where buyers visit" : "Sales office"}
            wide={editing}
            from={from(kit.officeAddress, "officeAddress")}
          >
            {editing ? (
              <textarea
                name="officeAddress"
                rows={2}
                defaultValue={kit.officeAddress ?? ""}
                placeholder="Sales lounge, ground floor, 12 Station Road, Pune 411001"
              />
            ) : (
              <Value text={kit.officeAddress} />
            )}
          </Row>
        </div>
      </section>
    </div>
  );
}

function FileSlot({
  role,
  file,
  nodeId,
  nodeName,
  editing,
}: {
  role: (typeof BRAND_FILE_ROLES)[number];
  file: BrandFile | undefined;
  nodeId: string;
  nodeName: string;
  editing: boolean;
}) {
  const inherited = file && file.nodeId !== nodeId;
  // Read-only, a mark says where it came from or that there is none; what
  // each one is for is said where somebody chooses the file.
  const note = inherited
    ? `From ${file.nodeName}`
    : editing
      ? role.detail
      : file
        ? null
        : "Not set";
  return (
    <div className="brandfile">
      <div className="brandfile__shot">
        {file && role.key !== "TYPEFACE" ? (
          <img
            // The id survives a replacement, because one mark per role per
            // node is an upsert rather than a second row. So the address of
            // the old bytes is the address of the new ones, the browser
            // serves what it already has, and a replaced logo looks for five
            // minutes like an upload that never happened. It is what made
            // three marks chosen at once read as one. The upload time moves
            // with the bytes, so the address does too.
            src={`/dashboard/library/branding/file/${file.id}?v=${Date.parse(file.uploadedAt)}`}
            alt={role.label}
          />
        ) : file ? (
          <span className="brandfile__font">Aa</span>
        ) : (
          <span className="brandfile__none" aria-hidden />
        )}
      </div>

      <div className="brandfile__body">
        <div className="brandfile__titleline">
          <strong>{role.label}</strong>
          {file && role.key !== "TYPEFACE" && (
            <MarkStatusBadge
              src={`/dashboard/library/branding/file/${file.id}?v=${Date.parse(file.uploadedAt)}`}
              role={role.key}
            />
          )}
        </div>
        {note && <small>{note}</small>}

        {editing && (
          // Belongs to the page's one form, so Save branding carries it along
          // with the tagline and the colours. Its own form is what used to
          // throw away everything chosen in the other three.
          <MarkPicker
            name={`file_${role.key}`}
            accept={acceptForRole(role.key)}
            role={role.key}
            label={file && !inherited ? "Replace this mark" : "Choose a file"}
          />
        )}

        {editing && file && !inherited && (
          <ConfirmAction
            label={`Remove from ${nodeName}`}
            title={`Remove the ${role.label.toLowerCase()} from ${nodeName}?`}
            body={
              <p>
                The file is deleted. Anything under {nodeName} that used it takes the one
                set above it instead, if there is one.
              </p>
            }
            confirmLabel="Remove it"
            action={removeBrandFileAction}
            fields={{ nodeId, role: role.key }}
            tone="risk"
            testId={`remove-${role.key}`}
          />
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  wide,
  from,
  children,
}: {
  label: string;
  wide?: boolean;
  from?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className={`formfield${wide ? " fieldgrid__wide" : ""}`}>
      <span className="formfield__label">
        {label}
        {from && <small className="hint">{from}</small>}
      </span>
      {children}
    </div>
  );
}

function Value({ text }: { text: string | null }) {
  if (!text) return <span className="formfield__unset">Not set</span>;
  return <span className="formfield__value">{text}</span>;
}

function Swatch({ hex }: { hex: string | null }) {
  if (!hex) return <span className="formfield__unset">Not set</span>;
  return (
    <span className="formfield__value swatch">
      <span className="swatch__chip" style={{ background: hex }} />
      {hex}
    </span>
  );
}
