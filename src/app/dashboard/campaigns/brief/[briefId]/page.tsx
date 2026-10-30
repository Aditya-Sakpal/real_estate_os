import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getViewer } from "@/lib/console";
import { loadBrief } from "@/lib/campaign";
import {
  briefGaps,
  isVideoType,
  objectiveLabel,
  FORMATS,
  HOOKS,
  LANGUAGES,
  MEDIA_TYPES,
  OBJECTIVES,
  REFERENCE_KINDS,
  type ReferenceKind,
} from "@/lib/campaign-rules";
import { listReferences, type BriefRow, type ReferenceRow } from "@/lib/campaign";
import { approvedUnits } from "@/lib/unit";
import { priceFor } from "@/lib/unit-rules";
import { saveBriefAction, setBriefStatusAction } from "@/app/actions/campaign";
import { ArrowLeft, ArrowUpRight, Check, Clock } from "@/components/icons";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import HookField from "./HookField";
import { AddReference, RemoveReference } from "./ReferenceForms";
import { WhatWorked } from "./WhatWorked";
import { learningFor } from "@/lib/learning";
import "./what-worked.css";
import "./brief.css";

const FORM = "briefform";

/**
 * One campaign brief.
 *
 * Opens read-only, because a brief that exists is a record and editing it is
 * a decision. Nothing here is signed, so there is no version and no hash: the
 * object that carries consequence is the Project Brain this campaign will
 * quote from, and it is immutable for that reason.
 */
export default async function BriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ briefId: string }>;
  searchParams: Promise<{
    edit?: string;
    error?: string;
    error_s?: string;
    saved?: string;
    ready?: string;
    reopened?: string;
  }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");

  const { briefId } = await params;
  const q = await searchParams;

  const view = await loadBrief(viewer.state.org.id, briefId);
  if (!view) notFound();

  const { node, brief } = view;
  // Read where the brief sits, not merely somewhere: a key held on one tower
  // is not a key to another tower's campaigns.
  if (!viewer.authz.canAt("campaign:read", node.path)) notFound();
  const error = readFlash(q, "error");
  const mayWrite = viewer.authz.canAt("campaign:create", node.path);
  const editing = q.edit === "1" && mayWrite;
  const gaps = briefGaps(brief);
  const [references, learning] = await Promise.all([
    listReferences(viewer.state.org.id, brief.id),
    learningFor(viewer.state.org.id, node.id),
  ]);

  // Approved ones only. Offering a configuration whose price nobody signed
  // would let a brief name something the studio then refuses to quote, and
  // the refusal would arrive after the copy had been paid for.
  const { units, basePsf } = await approvedUnits(viewer.state.org.id, node.id);
  const configurations = units.map((u) => {
    const price = priceFor(u, basePsf);
    return {
      value: u.id,
      label: u.nodeName === node.name ? u.label : `${u.label}, ${u.nodeName}`,
      detail:
        price === null
          ? `${u.carpetAreaSqft} sq ft carpet`
          : `${u.carpetAreaSqft} sq ft carpet, from Rs ${price.toLocaleString("en-IN")}`,
    };
  });

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href={`/dashboard/campaigns/${node.id}`} className="backlink">
            <ArrowLeft size={13} />
            {node.name}
          </Link>
          <h1 style={{ marginTop: 4 }}>{brief.name}</h1>
        </div>

        <div className="pagehead__acts">
          {brief.status === "READY" ? (
            <span className="pill pill--ok">
              <span className="pill__dot" />
              Ready
            </span>
          ) : (
            <span className="pill pill--warn">Draft</span>
          )}

          {/* One button while editing, and it saves. A "Done" sat beside it and
              left the editor WITHOUT saving, so the two read as the same
              action and one of them threw the work away. The brand kit lost
              its Done for the same reason. */}
          {editing ? (
            <button type="submit" form={FORM} className="btn btn--ink">
              Save the brief
              <Check size={14} />
            </button>
          ) : (
            mayWrite && (
              <>
                <Link
                  href={`/dashboard/campaigns/brief/${brief.id}?edit=1`}
                  className="btn btn--ghost"
                  data-edit
                >
                  Edit the brief
                </Link>
                <form action={setBriefStatusAction.bind(null, brief.status === "READY" ? "DRAFT" : "READY")}>
                  <input type="hidden" name="briefId" value={brief.id} />
                  <button
                    type="submit"
                    className={`btn ${brief.status === "READY" ? "btn--ghost" : "btn--ink"}`}
                    data-status
                  >
                    {brief.status === "READY" ? "Reopen for changes" : "Mark it ready"}
                    <ArrowUpRight size={14} />
                  </button>
                </form>
                {/* Ready is what makes a brief something to write from, so the
                    studio is where a ready brief leads and the primary action
                    moves here once it gets there. */}
                {brief.status === "READY" && (
                  <>
                    {/* A schedule is the same campaign run on its own, so it
                        sits beside the studio rather than in a section of its
                        own: one is "write it now", the other is "write it
                        every Tuesday". */}
                    <Link
                      href={`/dashboard/campaigns/brief/${brief.id}/schedule`}
                      className="btn btn--ghost"
                      data-schedule
                    >
                      Set a schedule
                      <Clock size={14} />
                    </Link>
                    <Link
                      href={`/dashboard/campaigns/brief/${brief.id}/studio`}
                      className="btn btn--ink"
                      data-studio
                    >
                      Open the studio
                      <ArrowUpRight size={14} />
                    </Link>
                  </>
                )}
              </>
            )
          )}
        </div>
      </div>

      <Flash text={error} name="error" style={{ marginBottom: 16 }} />
      {q.saved && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Saved.
        </div>
      )}
      {q.ready && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Marked ready.
        </div>
      )}
      {q.reopened && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Back to draft.
        </div>
      )}
      {!editing && gaps.length > 0 && brief.status !== "READY" && (
        <div className="note note--warn" style={{ marginBottom: 16 }}>
          <strong>Still to fill in</strong>
          {gaps.map((g) => g.label).join(", ")}.
        </div>
      )}

      {editing ? (
        // A refusal is said above the fields and keeps what was typed in them.
        <KeptForm action={saveBriefAction} id={FORM}>
          <input type="hidden" name="briefId" value={brief.id} />
          <Layout brief={brief} editing configurations={configurations} learning={learning} />
        </KeptForm>
      ) : (
        <Layout brief={brief} editing={false} configurations={configurations} learning={learning} />
      )}

      <References briefId={brief.id} references={references} editing={editing} />
    </>
  );
}

type Configuration = { value: string; label: string; detail: string };

/**
 * The brief's own cards beside a rail: the job and the creative set are the
 * work, the offer and what has worked sit beside them. The same places
 * whether it is being read or edited, so pressing Edit moves nothing.
 */
function Layout({
  brief,
  editing,
  configurations,
  learning,
}: {
  brief: BriefRow;
  editing: boolean;
  configurations: Configuration[];
  learning: Awaited<ReturnType<typeof learningFor>>;
}) {
  return (
    <div className={`split brieflayout${editing ? " brieflayout--editing" : ""}`}>
      <div className="split__main">
        <JobCard brief={brief} editing={editing} />
        <CreativeCard brief={brief} editing={editing} configurations={configurations} />
      </div>
      <div className="split__side">
        <ElseCard brief={brief} editing={editing} />
        <WhatWorked learning={learning} />
      </div>
    </div>
  );
}

/** Read-only, a card's fields are a grid; editing, they are the form's rows. */
function Fields({ editing, children }: { editing: boolean; children: React.ReactNode }) {
  return editing ? <>{children}</> : <div className="fieldgrid briefgrid">{children}</div>;
}

function JobCard({ brief, editing }: { brief: BriefRow; editing: boolean }) {
  return (
    <section className="card">
      <div className="card__head">
        <h2>The job</h2>
      </div>

      <Fields editing={editing}>
        <Row label="Campaign name" editing={editing}>
          {editing ? (
            <input
              type="text"
              name="name"
              defaultValue={brief.name}
              maxLength={80}
              required
              className="formfield__input"
            />
          ) : (
            <Value text={brief.name} />
          )}
        </Row>

        <Row label="Objective" required editing={editing}>
          {editing ? (
            <div className="checkset checkset--stack">
              {OBJECTIVES.map((o) => (
                <label key={o.key} className="checkset__item">
                  <input
                    type="radio"
                    name="objective"
                    value={o.key}
                    defaultChecked={brief.objective === o.key}
                  />
                  <span>
                    <strong>{o.label}</strong>
                    <small>{o.detail}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <Value text={objectiveLabel(brief.objective)} />
          )}
        </Row>

        <Row label="Audience" required editing={editing}>
          {editing ? (
            <textarea
              name="audience"
              rows={3}
              defaultValue={brief.audience ?? ""}
              placeholder="First time buyers, 30 to 42, working in BKC or Andheri"
            />
          ) : (
            <Value text={brief.audience} />
          )}
        </Row>

        <Row label="Micro-markets" hint="One per line, best first." editing={editing}>
          {editing ? (
            <textarea
              name="microMarkets"
              rows={4}
              defaultValue={brief.microMarkets.join("\n")}
              placeholder={"Goregaon East\nMalad West\nJogeshwari"}
              spellCheck={false}
            />
          ) : (
            <List items={brief.microMarkets} inline />
          )}
        </Row>

        <Row label="Call to action" required editing={editing}>
          {editing ? (
            <input
              type="text"
              name="cta"
              defaultValue={brief.cta ?? ""}
              maxLength={60}
              placeholder="Book a site visit this weekend"
              className="formfield__input"
            />
          ) : (
            <Value text={brief.cta} />
          )}
        </Row>
      </Fields>
    </section>
  );
}

function CreativeCard({
  brief,
  editing,
  configurations,
}: {
  brief: BriefRow;
  editing: boolean;
  configurations: Configuration[];
}) {
  return (
    <section className="card">
      <div className="card__head">
        <h2>The creative set</h2>
      </div>

      <Fields editing={editing}>
        <Row label="Languages" required editing={editing}>
          {editing ? (
            <CheckSet name="languages" options={LANGUAGES} chosen={brief.languages} />
          ) : (
            <List items={brief.languages} inline />
          )}
        </Row>

        <Row label="Formats" required editing={editing} wide>
          {editing ? (
            <CheckSet name="formats" options={FORMATS} chosen={brief.formats} />
          ) : (
            <List items={brief.formats} inline />
          )}
        </Row>

        {/* Only where the tower has approved configurations. A picker with
            nothing in it is a control that does nothing, and a brief written
            before any existed still means every one of them. */}
        {configurations.length > 0 && (
          <Row label="Configurations" editing={editing}>
            {editing ? (
              <PairSet
                name="unitTypeIds"
                options={configurations}
                chosen={brief.unitTypeIds}
                none="Every configuration this tower sells"
              />
            ) : (
              <List
                items={
                  brief.unitTypeIds.length
                    ? configurations
                        .filter((c) => brief.unitTypeIds.includes(c.value))
                        .map((c) => c.label)
                    : configurations.map((c) => c.label)
                }
                inline
              />
            )}
          </Row>
        )}

        <Row label="Hook" editing={editing}>
          {editing ? (
            <HookField name="hook" suggestions={HOOKS} defaultValue={brief.hook ?? ""} />
          ) : (
            <Value text={brief.hook} />
          )}
        </Row>
      </Fields>
    </section>
  );
}

function ElseCard({ brief, editing }: { brief: BriefRow; editing: boolean }) {
  return (
    <section className="card">
      <div className="card__head">
        <h2>Anything else</h2>
      </div>

      <Fields editing={editing}>
        <Row label="Offer variants" editing={editing}>
          {editing ? (
            <textarea
              name="offers"
              rows={3}
              defaultValue={brief.offers ?? ""}
              placeholder="No floor rise up to the 10th floor, until 30 November"
            />
          ) : (
            <Value text={brief.offers} />
          )}
        </Row>
      </Fields>
    </section>
  );
}

/**
 * The examples a brief points at.
 *
 * Uploads, not links. Asked for the post that worked, a person pastes the
 * address of the post, and a Meta permalink is an HTML page behind a login
 * rather than media. The file is the reference.
 *
 * Two lists rather than one with a flag, because a generator reads them as
 * opposite instructions and a row filed under the wrong one inverts its
 * meaning.
 *
 * Its own forms, one per tile and one per upload, which is why this sits
 * outside the brief form rather than inside it. Uploading saves on its own,
 * and the button says so.
 */
function References({
  briefId,
  references,
  editing,
}: {
  briefId: string;
  references: ReferenceRow[];
  editing: boolean;
}) {
  return (
    <section className="card briefrefs">
      <div className="card__head">
        <h2>References</h2>
        {editing && <span className="pill pill--quiet">Images and video, up to 25 MB each</span>}
      </div>

      <div className="refcols">
      {REFERENCE_KINDS.map((kind) => {
        const mine = references.filter((r) => r.kind === kind.key);
        return (
          <div key={kind.key} className="refgroup">
            <h3 className="refgroup__title">
              {kind.label}
              {mine.length > 0 && <span className="refgroup__count tnum">{mine.length}</span>}
            </h3>

            {mine.length === 0 && !editing ? (
              <p className="refgroup__none">Nothing uploaded.</p>
            ) : (
              <div className="refgrid">
                {mine.map((ref) => (
                  <Tile key={ref.id} briefId={briefId} reference={ref} editing={editing} />
                ))}
              </div>
            )}

            {editing && (
              <AddReference
                briefId={briefId}
                kind={kind.key as ReferenceKind}
                label={kind.label}
                add={kind.add}
                accept={MEDIA_TYPES.join(",")}
                placeholder={
                  kind.key === "WORKED"
                    ? "What worked about it. Optional."
                    : "What to stay away from. Optional."
                }
              />
            )}
          </div>
        );
      })}
      </div>
    </section>
  );
}

function Tile({
  briefId,
  reference,
  editing,
}: {
  briefId: string;
  reference: ReferenceRow;
  editing: boolean;
}) {
  const src = `/dashboard/campaigns/brief/${briefId}/reference/${reference.id}`;
  const mb = reference.mediaBytes / (1024 * 1024);
  return (
    <figure className="reftile">
      <div className="reftile__media">
        {isVideoType(reference.mediaType) ? (
          // `preload="metadata"` fetches the header and nothing else, so a
          // list of eight clips costs eight headers rather than eight files.
          <video src={src} controls preload="metadata" playsInline />
        ) : (
          <a href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={reference.note ?? reference.mediaName ?? "Reference"} />
          </a>
        )}
      </div>

      <figcaption className="reftile__foot">
        <span className="reftile__words">
          {reference.note ? (
            <strong>{reference.note}</strong>
          ) : (
            <strong className="reftile__untitled">{reference.mediaName ?? "Untitled"}</strong>
          )}
          <small>
            {isVideoType(reference.mediaType) ? "Video" : "Image"}
            {mb >= 0.1 ? ` · ${mb.toFixed(1)} MB` : ""}
          </small>
        </span>

        {editing && <RemoveReference briefId={briefId} referenceId={reference.id} />}
      </figcaption>
    </figure>
  );
}

/**
 * One labelled row.
 *
 * The required marker and the hint are instructions for filling the form, so
 * they appear only while it is being filled. Reading a finished brief, they
 * are noise: what is still missing is named once at the top instead.
 */
function Row({
  label,
  required,
  hint,
  editing,
  wide,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  editing: boolean;
  /** Read-only, a list of pills that needs the whole row. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`formfield${wide && !editing ? " fieldgrid__wide" : ""}`}
      style={editing ? { marginBottom: 18 } : undefined}
    >
      <span className="formfield__label">
        {label}
        {editing && required && <span className="formfield__req"> required</span>}
        {editing && hint && <small className="hint">{hint}</small>}
      </span>
      {children}
    </div>
  );
}

function Value({ text }: { text: string | null }) {
  if (!text) return <span className="formfield__unset">Not set</span>;
  return <span className="formfield__value">{text}</span>;
}

function List({ items, inline }: { items: string[]; inline?: boolean }) {
  if (!items.length) return <span className="formfield__unset">Not set</span>;
  if (inline) {
    return (
      <span className="formfield__value chipline">
        {items.map((i) => (
          <span key={i} className="pill pill--quiet">
            {i}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="formfield__value">
      {items.map((i) => (
        <span key={i} style={{ display: "block" }}>
          {i}
        </span>
      ))}
    </span>
  );
}

/**
 * A checkbox list whose value is not its label.
 *
 * `CheckSet` posts the word on screen, which is right for a language and
 * wrong for a configuration: "2 BHK" is the same string in nine towers, and
 * the price a refusal is measured against belongs to one row on one of them.
 * So this posts the id and shows the reading.
 *
 * Ticking nothing means all of them, which is what every brief written before
 * the column existed means, and the row says so rather than leaving an empty
 * list to be read as none.
 */
function PairSet({
  name,
  options,
  chosen,
  none,
}: {
  name: string;
  options: readonly Configuration[];
  chosen: string[];
  none: string;
}) {
  return (
    <div className="checkset checkset--wide">
      {options.map((o) => (
        <label key={o.value} className="checkset__item">
          <input
            type="checkbox"
            name={name}
            value={o.value}
            defaultChecked={chosen.includes(o.value)}
          />
          <span>
            <strong>{o.label}</strong>
            <small>{o.detail}</small>
          </span>
        </label>
      ))}
      <p className="checkset__none">{none}</p>
    </div>
  );
}

function CheckSet({
  name,
  options,
  chosen,
}: {
  name: string;
  options: readonly string[];
  chosen: string[];
}) {
  return (
    <div className="checkset">
      {options.map((o) => (
        <label key={o} className="checkset__item">
          <input type="checkbox" name={name} value={o} defaultChecked={chosen.includes(o)} />
          <span>
            <strong>{o}</strong>
          </span>
        </label>
      ))}
    </div>
  );
}
