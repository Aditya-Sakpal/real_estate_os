import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { inReach } from "@/lib/grant-rules";
import { listProjects } from "@/lib/project";
import { loadReview } from "@/lib/review";
import { reviewHeadline } from "@/lib/review-rules";
import { rupeesShort } from "@/lib/lead-rules";
import { approveShownAction } from "@/app/actions/review";
import { PageHead } from "@/components/shell/PageHead";
import { ReviewPictures } from "./ReviewPictures";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import "./review.css";

/**
 * One project's "Review and approve": the values read from documents, the
 * pictures and the flat types waiting for a yes, and the facts waiting to be
 * signed, for the project and every tower under it. Each list is what this
 * person may act on, and its one button acts on exactly the rows shown.
 */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!["brain:read", "asset:approve", "brain.price:approve"].some((p) => viewer.authz.can(p))) redirect("/dashboard/projects");
  const { id } = await params;
  const q = await searchParams;
  const orgId = viewer.state.org.id;
  const [projects, view] = await Promise.all([listProjects(orgId), loadReview(orgId, id, viewer.authz)]);
  const project = projects.find((p) => p.id === id);
  if (!project || !view) notFound();
  const keys = ["brain:read", "asset:approve", "brain.price:approve"].flatMap((p) => viewer.authz.scopesFor(p));
  if (!inReach(project.path, keys)) notFound();

  const empty = view.totals.values + view.totals.pictures + view.totals.flats + view.totals.drafts === 0;
  const Bulk = ({ kind, ids, label }: { kind: string; ids: string[]; label: string }) => (
    <form action={approveShownAction}>
      <input type="hidden" name="projectId" value={id} />
      <input type="hidden" name="kind" value={kind} />
      {ids.map((x) => (
        <input key={x} type="hidden" name="id" value={x} />
      ))}
      <button type="submit" className="btn btn--ink btn--sm" data-review-bulk={kind}>
        {label}
      </button>
    </form>
  );

  return (
    <>
      <PageHead
        title={
          <>
            Review and <span className="em">approve</span>
          </>
        }
        meta={`${project.name} · ${reviewHeadline(view.totals)}`}
        back={{ label: project.name, href: `/dashboard/projects/${id}` }}
      />

      <Flash text={readFlash(q, "done")} name="done" tone="info" />
      <Flash text={readFlash(q, "error")} name="error" />

      {empty && (
        <section className="card rv-empty">
          <p>Nothing on {project.name} is waiting for you.</p>
          {view.places.length > 0 && (
            <p className="rv-meta">
              Add the price list, brochure or RERA certificate and the values are read for you:{" "}
              {view.places.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && " · "}
                  <Link href={`/dashboard/brain/${p.id}/documents`}>{p.name}</Link>
                </span>
              ))}
            </p>
          )}
        </section>
      )}

      {view.values.length > 0 && (
        <section className="card rv-card" data-review="values">
          <header className="rv-head">
            <div>
              <h2>Values read from documents</h2>
              <p className="rv-meta">Least sure first. Open one to see it on its page.</p>
            </div>
            <Bulk kind="VALUES" ids={view.values.map((v) => v.id)} label={`Accept all ${view.values.length}`} />
          </header>
          <ul className="rv-list">
            {view.values.map((v) => (
              <li key={v.id} className="rv-row">
                <span className="rv-place">{v.place}</span>
                <span className="rv-what">
                  <strong>{v.field}</strong>
                  <span className="rv-value">{v.value}</span>
                </span>
                <span className="rv-meta">
                  {v.source}, page {v.page}
                </span>
                <span className={`pill ${v.confidence < 0.7 ? "pill--warn" : "pill--quiet"}`}>{Math.round(v.confidence * 100)}% sure</span>
              </li>
            ))}
          </ul>
          <p className="rv-meta rv-foot">
            To correct or reject one, open{" "}
            {[...new Set(view.values.map((v) => v.place))].map((name, i) => {
              const place = view.places.find((p) => p.name === name);
              return (
                <span key={name}>
                  {i > 0 && " · "}
                  {place ? <Link href={`/dashboard/brain/${place.id}/documents`}>{name}</Link> : name}
                </span>
              );
            })}
            .
          </p>
        </section>
      )}

      {view.pictures.length > 0 && (
        <section className="card rv-card" data-review="pictures">
          <header className="rv-head">
            <div>
              <h2>Pictures to approve</h2>
              <p className="rv-meta">Only approved pictures go on an ad.</p>
            </div>
            <Bulk kind="PICTURES" ids={view.pictures.map((p) => p.id)} label={`Approve all ${view.pictures.length}`} />
          </header>
          <ReviewPictures pictures={view.pictures} />
        </section>
      )}

      {view.flats.length > 0 && (
        <section className="card rv-card" data-review="flats">
          <header className="rv-head">
            <div>
              <h2>Flat types to approve</h2>
              <p className="rv-meta">The size and price an ad may print.</p>
            </div>
            <Bulk kind="FLATS" ids={view.flats.map((f) => f.id)} label={`Approve all ${view.flats.length}`} />
          </header>
          <ul className="rv-list">
            {view.flats.map((f) => (
              <li key={f.id} className="rv-row">
                <span className="rv-place">{f.place}</span>
                <span className="rv-what">
                  <strong>{f.label}</strong>
                  <span className="rv-value">{Math.round(f.carpet).toLocaleString("en-IN")} sq ft carpet</span>
                </span>
                <span className="rv-meta">{f.price ? `from ${rupeesShort(f.price)}` : "Priced from the signed rate"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.drafts.length > 0 && (
        <section className="card rv-card" data-review="facts">
          <header className="rv-head">
            <div>
              <h2>Facts to sign</h2>
              <p className="rv-meta">Each opens with one button that signs every section you may sign.</p>
            </div>
          </header>
          <ul className="rv-list">
            {view.drafts.map((d) => (
              <li key={d.nodeId} className="rv-row">
                <span className="rv-place">{d.place}</span>
                <span className="rv-what">
                  <strong>Version {d.version}, not live yet</strong>
                </span>
                <Link href={`/dashboard/brain/${d.nodeId}`} className="btn btn--ghost btn--sm">
                  Open to sign
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
