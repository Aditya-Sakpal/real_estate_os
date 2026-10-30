import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { loadDocuments, type DocumentRow } from "@/lib/extract";
import { docKindDef, docKindsFor, LOW_CONFIDENCE, MAX_RUNS_PER_DOCUMENT, showFound } from "@/lib/extract-rules";
import { fieldByKey } from "@/lib/brain-rules";
import { configLabel } from "@/lib/unit-rules";
import { onDate } from "@/lib/team";
import { projectOfNode } from "@/lib/storage-place";
import { readAgainAction, removeDocumentAction } from "@/app/actions/extract";
import { ConfirmAction } from "@/components/ConfirmAction";
import { ArrowLeft, ArrowUpRight, Check } from "@/components/icons";
import DocumentUpload from "./DocumentUpload";
import ValueCard, { type ValueView } from "./ValueCard";
import ReadingPoll from "./ReadingPoll";
import AddFlat from "./AddFlat";
import "./documents.css";

// A reading started from this page runs after the answer, in the same
// function, and a scanned brochure takes minutes. The worker finishes any
// that outlive it (`npm run extract:run`).
export const maxDuration = 300;

/**
 * A node's documents, and what was read from them.
 *
 * A work queue: upload at the top, then every value waiting for a person,
 * least sure first, each beside the words on the page it was read from. The
 * documents themselves and the flats a price list names come after, because
 * they are where the work came from rather than the work.
 */
export default async function DocumentsPage({ params }: { params: Promise<{ nodeId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("brain:read")) redirect("/dashboard");
  const { nodeId } = await params;
  const view = await loadDocuments(viewer.state.org.id, nodeId);
  if (!view) notFound();
  if (!viewer.authz.canAt("brain:read", view.node.path)) redirect("/dashboard");

  const { node, documents, review } = view;
  const mayEdit = viewer.authz.canAt("brain:edit", node.path);
  const mayRecordFlats = viewer.authz.canAt("unit:manage", node.path) && node.kind === "PHASE";
  const base = `/dashboard/brain/${node.id}/documents`;
  const names = new Map(documents.map((d) => [d.id, d]));
  const reading = documents.some((d) => d.reading && (d.reading.state === "QUEUED" || d.reading.state === "RUNNING"));
  const inDraft = review.filter((r) => r.inDraft).length;
  const kinds = docKindsFor(node.kind, node.exempt).map((k) => ({ key: k.key, label: k.label }));
  // Documents are read for a project or a tower; anywhere else has nothing to show.
  if (!kinds.length && !documents.length) redirect(`/dashboard/brain/${node.id}`);

  // A registration number waiting on the tower's filing opens the form that records it.
  const unfiled = review.some((r) => r.flags.some((f) => f.code === "REGISTRATION_UNFILED"));
  const projectId = unfiled && viewer.authz.canAt("rera:manage", node.path) ? await projectOfNode(viewer.state.org.id, node.id).catch(() => null) : null;
  const values: ValueView[] = review.map((r) => {
    const def = fieldByKey(r.field);
    const b = r.bbox;
    return {
      id: r.id,
      label: def?.type === "LIST" ? `${def.label}, one line` : def?.label ?? r.field,
      shown: showFound(r.field, r.value),
      raw: r.value,
      list: def?.type === "LIST",
      quote: r.quote.length > 180 ? `${r.quote.slice(0, 177)}...` : r.quote,
      from: names.get(r.documentId)?.name ?? r.documentName,
      page: r.page,
      crop: `${base}/${r.documentId}/page/${r.page}?box=${[b.x, b.y, b.w, b.h].map((n) => n.toFixed(4)).join(",")}`,
      pageSrc: `${base}/${r.documentId}/page/${r.page}`,
      bbox: b,
      unsure: r.confidence < LOW_CONFIDENCE,
      inDraft: r.inDraft,
      draftShown: r.draftValue ? showFound(r.field, r.draftValue) : null,
      flags: r.flags.map((f) => ({ tone: f.tone, message: f.message })),
      blocked: r.blocked,
      fix:
        projectId && r.flags.some((f) => f.code === "REGISTRATION_UNFILED")
          ? { label: "Record the registration", href: `/dashboard/projects/${projectId}?register=${node.id}#register` }
          : null,
      placeholder: def?.placeholder ?? "",
    };
  });

  const flats = documents.flatMap((d) => d.units.map((u) => ({ doc: d, ...u })));

  return (
    <>
      <ReadingPoll active={reading} />
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href={`/dashboard/brain/${node.id}`} className="backlink">
            <ArrowLeft size={14} />
            Back to the Brain
          </Link>
          <h1 style={{ marginTop: 4 }}>
            Read from <span className="em">documents</span>
          </h1>
          <p className="sub" style={{ marginTop: 6 }}>
            {node.name}
            {view.draftVersion ? ` · draft ${view.draftVersion}` : ""}
            {documents.length ? ` · ${documents.length} ${documents.length === 1 ? "document" : "documents"}` : ""}
          </p>
        </div>
      </div>

      <div className="docs">
        <div className="docs__main">
        {mayEdit && kinds.length > 0 && (
          <section className="card docs__upload" aria-labelledby="up-h">
            <div className="card__head">
              <h2 id="up-h">Upload a document</h2>
            </div>
            <DocumentUpload nodeId={node.id} kinds={kinds} />
          </section>
        )}

        <section className="card docs__queue" aria-labelledby="q-h">
          <div className="card__head">
            <h2 id="q-h">To check</h2>
            {review.length > 0 && <span className="pill pill--blue">{review.length}</span>}
          </div>
          {values.length ? (
            <ul className="vals">
              {values.map((v) => (
                <ValueCard key={v.id} v={v} mayEdit={mayEdit} />
              ))}
            </ul>
          ) : (
            <div className="empty docs__empty">
              <div className="empty__mark">
                <Check size={16} />
              </div>
              {documents.length ? "Nothing waiting. Every value read has been decided." : "Values read from a document appear here, each beside its page."}
            </div>
          )}
        </section>
        </div>

        <div className="docs__side">
          <Status
            nodeId={node.id}
            inDraft={inDraft}
            differing={review.length - inDraft}
            documents={documents.length}
            reading={reading}
          />

          <section className="card" aria-labelledby="d-h">
            <div className="card__head">
              <h2 id="d-h">Documents</h2>
            </div>
            {documents.length ? (
              <ul className="docrows">
                {documents.map((d) => (
                  <DocRow key={d.id} d={d} base={base} mayEdit={mayEdit} />
                ))}
              </ul>
            ) : (
              <p className="sub docs__none">None yet.</p>
            )}
          </section>

          {flats.length > 0 && (
            <section className="card" aria-labelledby="f-h">
              <div className="card__head">
                <h2 id="f-h">Flats on the documents</h2>
              </div>
              <ul className="flats">
                {flats.map((f, i) => (
                  <li key={i} className="flat">
                    <div className="flat__what">
                      <span className="flat__name">{configLabel(f.row.config)}</span>
                      <span className="flat__facts">
                        {[f.row.carpetSqft ? `${f.row.carpetSqft} sq ft` : null, f.row.price ? showFound("price.booking_amount", String(f.row.price)) : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <span
                      className={`pill ${f.status === "MATCHES" ? "pill--ok" : f.status === "NOT_RECORDED" ? "pill--quiet" : "pill--warn"}`}
                    >
                      {f.status === "MATCHES" ? "Matches" : f.status === "NOT_RECORDED" ? "Not recorded" : f.status === "PRICE_DIFFERS" ? "Price differs" : "Size differs"}
                    </span>
                    {f.status !== "MATCHES" && f.status !== "NOT_RECORDED" && (
                      <p className="flat__why">
                        {f.message}
                        {f.status === "PRICE_DIFFERS" && f.filedPrice ? ` On file: ${showFound("price.booking_amount", String(f.filedPrice))}.` : ""}
                      </p>
                    )}
                    {f.status === "NOT_RECORDED" && mayRecordFlats && (
                      <AddFlat nodeId={node.id} config={f.row.config} carpet={f.row.carpetSqft} balcony={f.row.balconySqft} price={f.row.price} towerName={node.name} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** The group's one near-black card: what stands between these documents and a signature. */
function Status({ nodeId, inDraft, differing, documents, reading }: { nodeId: string; inDraft: number; differing: number; documents: number; reading: boolean }) {
  const [title, body] =
    inDraft > 0
      ? [`${inDraft} ${inDraft === 1 ? "value is" : "values are"} in the draft, not checked`, "Signing waits until each is accepted, corrected or rejected."]
      : differing > 0
        ? [`${differing} ${differing === 1 ? "value differs" : "values differ"} from the draft`, "The draft keeps what it has until you choose."]
        : reading
          ? ["Reading", "Values appear as each document is read."]
          : documents > 0
            ? ["Everything read is decided", "The Brain is ready for its signatures."]
            : ["Nothing uploaded yet", "The RERA certificate and the price list fill the most."];
  const done = inDraft === 0 && differing === 0 && documents > 0 && !reading;
  return (
    <section className="card docs__status" aria-live="polite">
      <h2>{title}</h2>
      <p>{body}</p>
      {done && (
        <Link href={`/dashboard/brain/${nodeId}`} className="btn btn--light btn--sm">
          Go to the Brain
          <ArrowUpRight size={13} />
        </Link>
      )}
    </section>
  );
}

function readingLine(d: DocumentRow): { text: string; tone: "quiet" | "ok" | "risk" | "blue" } {
  const r = d.reading;
  if (!r) return { text: "Not read", tone: "quiet" };
  if (r.state === "QUEUED") return { text: "Waiting to be read", tone: "blue" };
  if (r.state === "RUNNING") {
    if (r.stage === "READING") return { text: `Reading page ${Math.min(r.pagesDone + 1, d.pages)} of ${d.pages}`, tone: "blue" };
    if (r.stage === "WRITING") return { text: "Almost done", tone: "blue" };
    return { text: "Picking out the facts", tone: "blue" };
  }
  if (r.state === "FAILED") return { text: r.error ?? "Could not read it.", tone: "risk" };
  if (r.found === 0) return { text: "Read. Nothing to take from it here.", tone: "quiet" };
  return { text: `Found ${r.found} ${r.found === 1 ? "fact" : "facts"}${d.matched ? `, ${d.matched} already in the Brain` : ""}`, tone: "ok" };
}

function DocRow({ d, base, mayEdit }: { d: DocumentRow; base: string; mayEdit: boolean }) {
  const line = readingLine(d);
  const busy = d.reading?.state === "QUEUED" || d.reading?.state === "RUNNING";
  return (
    <li className="docrow" id={`doc-${d.id}`} data-doc={d.id}>
      <div className="docrow__top">
        <span className="pill pill--quiet">{docKindDef(d.kind)?.label ?? d.kind}</span>
        <span className="docrow__meta">
          {d.pages} {d.pages === 1 ? "page" : "pages"} · {onDate(d.createdAt)}
        </span>
      </div>
      <a className="docrow__name" href={`${base}/${d.id}/file`} target="_blank" rel="noreferrer">
        {d.name}
      </a>
      <p className={`docrow__state docrow__state--${line.tone}`} data-doc-state={d.reading?.state ?? "NONE"}>
        {busy && <span className="docrow__spin" aria-hidden />}
        {line.text}
      </p>
      {mayEdit && !busy && (
        <div className="docrow__acts">
          {d.runsLeft > 0 ? (
            <form action={readAgainAction}>
              <input type="hidden" name="documentId" value={d.id} />
              <button type="submit" className="btn btn--sm btn--ghost" data-read-again="">
                Read again
              </button>
            </form>
          ) : (
            <span className="pill pill--quiet" title={`Read ${MAX_RUNS_PER_DOCUMENT} times`}>
              Read {MAX_RUNS_PER_DOCUMENT} times
            </span>
          )}
          {d.kept ? (
            <span className="pill pill--quiet">Kept: values were taken from it</span>
          ) : (
            <ConfirmAction
              label="Remove"
              title={`Remove ${d.name}?`}
              body="Its values that nobody has checked come out of the draft too."
              confirmLabel="Remove the document"
              action={removeDocumentAction}
              fields={{ documentId: d.id }}
              tone="risk"
              testId="remove-doc"
            />
          )}
        </div>
      )}
    </li>
  );
}
