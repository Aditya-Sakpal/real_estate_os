import { redirect } from "next/navigation";
import { sellsForOthers } from "@/lib/mandate-rules";
import { getViewer } from "@/lib/console";
import { listEntities } from "@/lib/entity";
import { onDate } from "@/lib/team";
import { createEntityAction, updateEntityAction } from "@/app/actions/scope";
import Link from "next/link";
import { Building, ArrowUpRight } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import "./entities.css";

/**
 * Legal entities.
 *
 * The first thing anyone adds beneath the org root, and the reason it comes
 * before projects: under RERA the promoter of record is the SPV, not the
 * parent brand, and the portal matches on that legal name.
 */
export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("project:read") && !viewer.authz.can("project:create")) {
    redirect("/dashboard");
  }

  const canCreate = viewer.authz.can("project:create");
  const entities = await listEntities(viewer.state.org.id);
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // Only a message we signed is printed. `created` and `edit` are only ever
  // compared against real rows, never shown as given.
  const error = readFlash(q, "error");
  const created = one(q.created);
  const edit = one(q.edit);
  const editing = edit ? entities.find((e) => e.id === edit) : undefined;
  // A mandate firm files each developer it sells for here: the company a
  // project is registered under is the developer's, never the firm's.
  const firm = sellsForOthers(viewer.orgType);
  const noun = firm ? { one: "developer", many: "developers" } : { one: "entity", many: "entities" };

  return (
    <>
      <PageHead
        back={firm ? { label: "Developers", href: "/dashboard/developers" } : { label: "Settings", href: "/dashboard/settings" }}
        title={
          firm ? (
            <>
              Developers&rsquo; <span className="em">legal</span> details
            </>
          ) : (
            <>
              Who actually <span className="em">registers</span>
            </>
          )
        }
        meta={
          <>
            {entities.length === 0
              ? firm ? "No developer yet" : "No legal entity yet"
              : `${entities.length} ${entities.length === 1 ? noun.one : noun.many}`}{" "}
            · {viewer.state.org.displayName}
          </>
        }
      />

      <Flash text={error} name="error" tone="risk" style={{ marginBottom: 16 }} />

      <div className={canCreate ? "split ent" : "stack ent"}>
      <section className="card">
        <div className="card__head">
          <h2>{firm ? "Developers" : "Entities"}</h2>
          {entities.length > 0 && (
            <span className="pill pill--quiet">{entities.length}</span>
          )}
        </div>

        {entities.length === 0 ? (
          <div className="empty" style={{ padding: "26px 20px" }}>
            <div className="empty__mark">
              <Building size={19} />
            </div>
            <p style={{ maxWidth: "60ch", margin: "0 auto" }}>
              {firm ? "Add each developer company whose projects you sell." : "Add the company each project registers under."}
            </p>
          </div>
        ) : (
          <div className="people">
            {entities.map((e) => (
              <div key={e.id} className="person ent__row">
                <span className="person__face">
                  <Building size={15} />
                </span>
                <span className="person__id">
                  <span className="person__name">
                    {e.name}
                    {created === e.path && <span className="pill pill--ok">New</span>}
                  </span>
                  <span className="person__mail">
                    {e.pan ?? "no PAN recorded"}
                    {e.registrationNo ? ` · ${e.registrationKind} ${e.registrationNo}` : ""}
                    {" · "}
                    {e.projectCount === 0
                      ? "no projects"
                      : `${e.projectCount} ${e.projectCount === 1 ? "project" : "projects"}`}
                  </span>
                </span>
                <span className="person__when">
                  {canCreate ? (
                    <Link
                      href={`/dashboard/settings/entities?edit=${e.id}`}
                      className="btn btn--ghost btn--sm"
                    >
                      Edit
                    </Link>
                  ) : (
                    onDate(e.createdAt)
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {canCreate && (
        <section id="add" className="card ent__form" style={{ scrollMarginTop: 80 }}>
          <div className="card__head">
            <h2>{editing ? `Edit ${editing.name}` : firm ? "Add a developer" : "Add an entity"}</h2>
            {editing && (
              <Link href="/dashboard/settings/entities" className="btn btn--ghost btn--sm">
                Cancel
              </Link>
            )}
          </div>

          {/* Keyed, so switching entities by address, or landing back after a
              save, remounts it with that entity's values rather than keeping
              what was typed for another. */}
          <KeptForm
            key={editing ? `edit-${editing.id}` : `new-${created ?? ""}`}
            action={editing ? updateEntityAction : createEntityAction}
          >
            {editing && <input type="hidden" name="entityId" value={editing.id} />}
            <div className="field">
              <label htmlFor="legalName">{firm ? "Developer's registered legal name" : "Registered legal name"}</label>
              <input
                id="legalName"
                type="text"
                name="legalName"
                defaultValue={editing?.name ?? ""}
                placeholder="Riverstone Homes Private Limited"
                maxLength={200}
                required
              />
              <p className="hint">Exactly as on the registration.</p>
            </div>

            <div className="roleform__pair">
              <div className="field">
                <label htmlFor="pan">PAN</label>
                <input
                  id="pan"
                  type="text"
                  name="pan"
                  defaultValue={editing?.pan ?? ""}
                  placeholder="ABCCD1234E"
                  maxLength={10}
                  required
                  style={{ textTransform: "uppercase" }}
                />
              </div>
              <div className="field">
                <label htmlFor="registrationNo">CIN or LLPIN</label>
                <input
                  id="registrationNo"
                  type="text"
                  name="registrationNo"
                  defaultValue={editing?.registrationNo ?? ""}
                  placeholder="U45200MH2015PTC000000"
                  maxLength={25}
                  style={{ textTransform: "uppercase" }}
                />
                <p className="hint">
                  Optional. A proprietorship or partnership firm holds neither.
                </p>
              </div>
            </div>

            <div className="field">
              <label htmlFor="registeredAddress">Registered address</label>
              <input
                id="registeredAddress"
                type="text"
                name="registeredAddress"
                defaultValue={editing?.registeredAddress ?? ""}
                placeholder="Optional, as on the incorporation record"
                maxLength={400}
              />
            </div>

            <button type="submit" className="btn btn--ink">
              {editing ? (firm ? "Save developer" : "Save entity") : firm ? "Add developer" : "Create entity"}
              <ArrowUpRight size={14} />
            </button>
          </KeptForm>

          {editing && (
            <p className="sub" style={{ marginTop: 14, maxWidth: "68ch" }}>
              Renaming changes the name only. Projects and people stay where
              they are.
            </p>
          )}

        </section>
      )}
      </div>
    </>
  );
}
