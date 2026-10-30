import Link from "next/link";
import type { Viewer } from "@/lib/console";
import { ownProjectLinks, partnerWork } from "@/lib/partner-workspace";
import { partnerAutoRegister } from "@/lib/partners";
import { EMPANELMENT_WORDS, partnerTotals, rateLine } from "@/lib/partner-workspace-rules";
import { docState, istDay } from "@/lib/partner-rules";
import { longDay } from "@/lib/mandate-rules";
import { listEntities } from "@/lib/entity";
import { listProjects } from "@/lib/project";
import { inReach } from "@/lib/grant-rules";
import { ArrowUpRight, Building, Download } from "@/components/icons";
import { CopyLink, MakeLink } from "./LinkControls";
import { PartnerHead } from "./PartnerHead";
import { AutoRegisterSwitch, OwnProjectLink } from "./AutoRegister";
import { addedProjects, refreshLinkedTowers } from "@/lib/linked-projects";
import { addDeveloperProjectAction } from "@/app/actions/partner-claims";
import { KeptForm } from "@/components/KeptForm";
import { outsideDevelopers } from "@/lib/outside";

/**
 * A channel partner's developers. The ones on Sales Desk that empanelled it
 * (or a mandate firm did, for them): where each empanelment stands, what the
 * next booking earns, its link for each tower, the developer's approved
 * posts with its band beneath them, and who is on that developer's
 * WhatsApp list for it. Then the developers it added itself, whose projects
 * it works in this console.
 */
export async function PartnerDevelopers({ viewer }: { viewer: Viewer }) {
  const orgId = viewer.state.org.id;
  const today = istDay(new Date().toISOString());
  const canAdd = viewer.authz.can("project:create");
  const seesProjects = canAdd || viewer.authz.can("project:read");
  // A tower a developer added since the partner added its project is brought in first.
  if (canAdd) await refreshLinkedTowers(orgId, viewer.userId);
  const [work, allEntities, allProjects, autoOn, links, inMine] = await Promise.all([
    partnerWork(orgId),
    seesProjects ? listEntities(orgId) : Promise.resolve([]),
    seesProjects ? listProjects(orgId) : Promise.resolve([]),
    partnerAutoRegister(orgId),
    ownProjectLinks(orgId),
    addedProjects(orgId),
  ]);
  // The developers not on Sales Desk: where each takes registrations.
  const outside = new Map((await outsideDevelopers(orgId)).map((d) => [d.entityId, d]));
  // The firm's admin links its own projects to the developers' and decides whether its leads are registered by themselves.
  const mayLink = viewer.authz.can("org:manage") && seesProjects;
  const mayWork = viewer.authz.can("partner:register");
  const seesMoney = viewer.authz.can("payout:read");
  const liveCount = work.developers.reduce((n, d) => n + d.projects.filter((p) => p.status === "live").length, 0);
  const totals = partnerTotals(work.bookings, today);

  const reach = [...new Set([...viewer.authz.scopesFor("project:read"), ...viewer.authz.scopesFor("project:create")])];
  const projects = allProjects.filter((p) => inReach(p.path, reach));
  const own = (canAdd ? allEntities : allEntities.filter((e) => projects.some((p) => p.entityId === e.id))).map((e) => ({
    id: e.id,
    name: e.name,
    projects: projects.filter((p) => p.entityId === e.id).map((p) => p.name),
  }));

  const meta =
    work.developers.length === 0 && own.length === 0
      ? `No developer yet · developers find you by your PAN, ${viewer.state.org.pan}`
      : [
          work.developers.length ? `${liveCount} ${liveCount === 1 ? "project" : "projects"} empanelled` : null,
          own.length ? `${own.length} added by you` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const added = (
    <section className="card fw-card" aria-label="Developers you added">
      <div className="fw-card__head">
        <h2>Developers you added</h2>
        {canAdd && (
          <Link href="/dashboard/settings/entities#add" className="btn btn--ghost btn--sm">
            Add a developer
            <ArrowUpRight size={13} />
          </Link>
        )}
      </div>
      {own.length === 0 ? (
        <p className="fw-empty">Add a developer and its projects to run your own leads, calls, visits and ads for them.</p>
      ) : (
        <ul className="fw-open">
          {own.map((e) => (
            <li key={e.id} className="fw-open__row" data-developer="own">
              <span className="fw-open__what">
                <span className="fw-open__dev">{e.name}</span>
                <span className="fw-open__line">{e.projects.length > 0 ? e.projects.join(", ") : "No project yet"}</span>
              </span>
              {outside.has(e.id) && (
                <Link href={`/dashboard/developers/added/${e.id}`} className="btn btn--ghost" data-outside-setup={e.id}>
                  {outside.get(e.id)!.setup ? "Registrations and invoicing" : "Set up registrations"}
                </Link>
              )}
              {e.projects.length > 0 || canAdd ? (
                <Link href="/dashboard/projects" className="btn btn--ghost">
                  {e.projects.length > 0 ? "Projects" : "Add a project"}
                  <ArrowUpRight size={14} />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      <PartnerHead
        current="projects"
        meta={meta}
        counts={{ buyers: work.buyers.length, toInvoice: totals.toInvoice }}
        seesMoney={seesMoney}
        canRegister={mayWork && liveCount > 0}
      />

      <div className="fw-stack">
        {/* Two short cards with nothing under them yet: side by side, not two bars. */}
        {work.developers.length === 0 && (
          <div className="pair pair--stretch">
            <section className="fw-offers" aria-label="No developer has empanelled you yet">
              <h2>No developer on Sales Desk has empanelled you yet</h2>
              <p className="fw-offer__line" style={{ margin: 0, fontSize: 13.5 }}>
                They add you by your PAN, <span className="pt-mono">{viewer.state.org.pan}</span>. Give it to the relationship managers you work
                with; their projects, your links and your brokerage then appear here.
              </p>
            </section>
            {added}
          </div>
        )}

        {mayLink && work.developers.length > 0 && projects.length > 0 && (
          <section className="card fw-card" aria-label="Your leads and the developers">
            <AutoRegisterSwitch on={autoOn} linked={links.length} />
          </section>
        )}

        {work.developers.map((d) => {
          const file = docState(d.agentOnFile.reraNo ? d.agentOnFile.reraTill : null, today);
          const people = work.people.filter((p) => p.devOrgId === d.orgId);
          return (
            <section key={d.orgId} className="card fw-card" aria-label={d.name}>
              <div className="fw-card__head">
                <h2>
                  {d.name}
                  {d.through ? <span className="fw-card__meta"> · through {d.through}</span> : null}
                </h2>
                <span className="fw-card__meta">{d.rm ? `Looked after by ${d.rm}` : "No relationship manager named yet"}</span>
              </div>

              {(file === "expired" || file === "missing" || file === "expiring") && (
                <p className={`note ${file === "expiring" ? "note--warn" : "note--risk"}`} style={{ marginTop: 0 }}>
                  {file === "missing"
                    ? `${d.name} holds no MahaRERA agent registration for you. Send it to ${d.rm ?? "your relationship manager"}.`
                    : file === "expired"
                      ? `The agent registration ${d.name} holds for you lapsed on ${longDay(d.agentOnFile.reraTill!)}. Send ${d.rm ?? "your relationship manager"} the renewed one.`
                      : `${d.name} holds your agent registration until ${longDay(d.agentOnFile.reraTill!)}.`}
                </p>
              )}

              {d.projects.map((p) => (
                <div key={p.id} className="fw-proj">
                  <div className="fw-proj__head">
                    <span className="fw-proj__name">{p.name}</span>
                    <span className={`pill pill--${EMPANELMENT_WORDS[p.status].tone}`}>
                      <span className="pill__dot" />
                      {p.status === "live" ? `Empanelled until ${longDay(p.validTo)}` : p.status === "ended" ? `Ended ${longDay(p.validTo)}` : EMPANELMENT_WORDS[p.status].label}
                    </span>
                  </div>
                  <p className="fw-proj__line">
                    {rateLine(p.steps, p.booked)} · a buyer stays yours for {p.registrationDays} days
                  </p>
                  {inMine.has(`${d.orgId}:${p.id}`) ? (
                    <p className="fw-proj__line" style={{ marginTop: 8 }}>
                      <Link href={`/dashboard/projects/${inMine.get(`${d.orgId}:${p.id}`)}`} data-own-project>
                        Open in your projects
                      </Link>
                    </p>
                  ) : (
                    canAdd &&
                    p.status === "live" && (
                      <KeptForm action={addDeveloperProjectAction} className="fw-add-project" style={{ marginTop: 8 }}>
                        <input type="hidden" name="devOrgId" value={d.orgId} />
                        <input type="hidden" name="devProjectId" value={p.id} />
                        <button type="submit" className="btn btn--ink btn--sm" data-add-project>
                          Add to my projects
                        </button>
                      </KeptForm>
                    )
                  )}
                  {mayLink && p.status === "live" && projects.length > 0 && !inMine.has(`${d.orgId}:${p.id}`) && (
                    <OwnProjectLink
                      devOrgId={d.orgId}
                      devProjectId={p.id}
                      current={links.find((k) => k.devOrgId === d.orgId && k.devProjectId === p.id)?.ownProjectId ?? null}
                      projects={projects.map((x) => ({ id: x.id, name: `${x.name} · ${x.entityName}` }))}
                    />
                  )}

                  {p.status === "live" && p.towers.length > 0 && (
                    <>
                      <h3 className="fw-sub">Your link, by tower</h3>
                      <ul className="fw-towers">
                        {p.towers.map((t) => (
                          <li key={t.id} className="fw-tower">
                            <span className="fw-buyer">
                              <span className="fw-tower__name">{t.name}</span>
                              {t.link && (
                                <span className="fw-buyer__line">
                                  {t.link.whatsapp ? "Opens WhatsApp to the developer" : "Opens the enquiry page"} · {t.link.claims}{" "}
                                  {t.link.claims === 1 ? "buyer" : "buyers"} from it
                                </span>
                              )}
                            </span>
                            {t.link ? (
                              <span className="fw-link">
                                <span className="fw-link__code">{t.link.code}</span>
                                {t.link.url && <CopyLink url={t.link.url} />}
                              </span>
                            ) : !t.advertisable ? (
                              <span className="fw-buyer__line">Can&rsquo;t be advertised yet</span>
                            ) : mayWork ? (
                              <MakeLink devOrgId={d.orgId} towerId={t.id} />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {p.status === "live" && p.posts.length > 0 && (
                    <>
                      <h3 className="fw-sub">Posts with your name on them</h3>
                      <ul className="fw-posts">
                        {p.posts.slice(0, 9).map((post) => (
                          <li key={post.id} className="fw-post">
                            {mayWork && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                className="fw-post__pic"
                                src={`/dashboard/developers/post/${d.orgId}/${post.id}/0/preview`}
                                alt={post.headline}
                                loading="lazy"
                                width={480}
                                height={480}
                              />
                            )}
                            <span className="fw-buyer">
                              <span className="fw-post__what">{post.headline}</span>
                              <span className="fw-post__line">
                                {post.tower} · {post.kind === "CAROUSEL" ? `Carousel, ${post.frames} slides` : post.placement}
                              </span>
                            </span>
                            {mayWork && (
                              <span className="fw-post__get">
                                {Array.from({ length: post.kind === "CAROUSEL" ? post.frames : 1 }, (_, i) => (
                                  <Link key={i} href={`/dashboard/developers/post/${d.orgId}/${post.id}/${i}`} prefetch={false} className="btn btn--ghost btn--sm">
                                    <Download size={13} />
                                    {post.kind === "CAROUSEL" ? `Slide ${i + 1}` : "Download"}
                                  </Link>
                                ))}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ))}

              {people.length > 0 && (
                <div className="fw-proj">
                  <h3 className="fw-sub" style={{ marginTop: 0 }}>
                    On {d.name}&rsquo;s WhatsApp for you
                  </h3>
                  <ul className="fw-towers">
                    {people.map((p) => (
                      <li key={p.id} className="fw-tower">
                        <span className="fw-buyer">
                          <span className="fw-tower__name">
                            {p.name}
                            {p.principal ? " · principal" : ""}
                          </span>
                          <span className="fw-buyer__line tnum">{p.phone}</span>
                        </span>
                        <span className={`pill pill--${p.proved ? "ok" : "quiet"}`}>
                          <span className="pill__dot" />
                          {p.proved ? "Number proved" : "Waiting for their first message"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          );
        })}

        {work.developers.length > 0 && added}
      </div>
    </>
  );
}
