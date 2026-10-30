import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { loadTeam, onDate, matchLabel } from "@/lib/team";
import { listOrgRoles, missingToGrant, roleFitsScope } from "@/lib/rbac";
import { FOUNDING_ROLE } from "@/lib/roles";
import {
  approveJoinAction,
  changeRoleAction,
  rejectJoinAction,
  removeMemberAction,
} from "@/app/actions/team";
import { inviteAction, revokeInviteAction } from "@/app/actions/invite";
import {
  promoteAdminAction,
  transferAdminAction,
  demoteAdminAction,
} from "@/app/actions/admin";
import { ImportPeople } from "./ImportPeople";
import { ScopedRole } from "./ScopedRole";
import { listInvites } from "@/lib/invite";
import { listScopeNodes } from "@/lib/scope-nodes";
import { nodesWithin, reachFor } from "@/lib/scope-rules";
import { readFlash } from "@/lib/flash";
import { KeptForm } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { Person, Alert, Clock, ArrowUpRight } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import { listPhonePeople } from "@/lib/partner-team";
import { mayInviteByPhone, phonePersonState } from "@/lib/partner-team-rules";
import { invitePhoneAction, removePhonePersonAction } from "@/app/actions/partner-team";
import { showPhone } from "@/lib/call-rules";
import "./team.css";

type Query = Record<string, string | string[] | undefined>;

/** A count the import put in the address, or null for anything that is not one. */
function countIn(q: Query, name: string): number | null {
  const v = q[name];
  return typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : null;
}

/** A membership id the admin actions put in the address, or null. */
function idIn(q: Query, name: string): string | null {
  const v = q[name];
  return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  // The rail hiding an item is presentation. This is the actual gate: an
  // auditor typing the URL gets the same answer as an auditor reading the rail.
  if (!viewer.authz.can("member:read")) redirect("/dashboard");

  const orgId = viewer.state.org.id;
  // A channel partner firm adds its own people by phone as well.
  const byPhone = mayInviteByPhone(viewer.orgType) && viewer.authz.can("member:invite") && !viewer.via;
  const [team, roles, allNodes, invites, phonePeople] = await Promise.all([
    loadTeam(orgId, viewer.userId, viewer.authz),
    listOrgRoles(orgId),
    listScopeNodes(orgId),
    viewer.authz.can("member:invite") ? listInvites(orgId) : [],
    byPhone ? listPhonePeople(orgId) : [],
  ]);

  // Where this viewer may put somebody: the subtrees they hold
  // `member:invite` in, and everything beneath. Filtering the picker is
  // presentation; the action reads the node back inside the tenant and
  // refuses anything outside this set whether or not it was ever offered.
  const nodes = nodesWithin(allNodes, viewer.authz.scopesFor("member:invite"));

  // Roles worth offering, each with where: deep enough, and where this
  // viewer holds everything the role does. Site Team stays hidden until a
  // phase exists, and a role carrying access the viewer lacks stays hidden
  // where they lack it. The founding role falls out of the same rule.
  const reachable = reachFor(roles, nodes, viewer.authz.heldAt);

  // Changing somebody's role is its own key, with its own reach.
  const changeReach = reachFor(
    roles,
    nodesWithin(allNodes, viewer.authz.scopesFor("member:role")),
    viewer.authz.heldAt,
  );

  // Stepping down or handing over changes an existing membership, and an
  // admin's membership is at the root, so those pickers stay at root depth.
  // `resolveRole()` in the action enforces the same thing.
  const atRoot = roles.filter((r) => roleFitsScope(r, "ORG"));

  // Approving a stranger's request and inviting a named person are different
  // acts, so they offer different roles. A request is answered with an
  // ordinary role; promoting someone to admin is deliberate. But an admin must
  // be able to INVITE a second admin, because "add a second admin" is the
  // first thing the setup queue asks for, and it pointed at a picker that did
  // not contain the role.
  const grantable = atRoot.filter((r) => r.key !== FOUNDING_ROLE);
  const viewerIsFounding = viewer.authz.roleKeys.includes(FOUNDING_ROLE);
  const invitable = reachable;
  const approvable = reachable.filter((r) => r.key !== FOUNDING_ROLE);

  // What this viewer may do to one membership: change it or end it only where
  // they hold everything its role holds, never their own, and never the
  // admin role, which has its own controls below.
  const heldBy = new Map<string, number>();
  for (const m of team.members) heldBy.set(m.userId, (heldBy.get(m.userId) ?? 0) + 1);
  const controlsFor = (m: (typeof team.members)[number]) => {
    if (m.isYou || m.role === FOUNDING_ROLE) return { moveTo: [], remove: false };
    const permissions = roles.find((r) => r.key === m.role)?.permissions ?? [];
    const outranks = missingToGrant(viewer.authz.heldAt(m.scopePath), permissions).length === 0;
    if (!outranks) return { moveTo: [], remove: false };
    return {
      moveTo: viewer.authz.canAt("member:role", m.scopePath)
        ? changeReach.filter(
            (r) => r.at.includes(m.scopeNodeId) && r.key !== m.role && r.key !== FOUNDING_ROLE,
          )
        : [],
      remove: viewer.authz.canAt("member:remove", m.scopePath),
    };
  };

  const params = await searchParams;
  // Messages are read only when they carry our signature, so a link cannot
  // print a banner of its own in our voice.
  const error = readFlash(params, "error");
  const invited = readFlash(params, "invited");
  const unsent = readFlash(params, "unsent");
  const address = readFlash(params, "address");
  const memberNote = readFlash(params, "member");
  const phoneAdded = readFlash(params, "phoneAdded");

  // The import's counts, printed only as numbers.
  const imported = countIn(params, "imported");
  const skipped = countIn(params, "skipped") ?? 0;
  const refused = countIn(params, "refused") ?? 0;
  const mailFailed = countIn(params, "mailFailed") ?? 0;

  // Who an admin change was about is looked up from the id, and said only
  // when the team as it stands now agrees with it.
  const memberAt = (name: string) => {
    const id = idIn(params, name);
    return id ? team.members.find((m) => m.membershipId === id) : undefined;
  };
  const promoted = memberAt("promoted");
  const transferred = memberAt("transferred");
  const demoted = memberAt("demoted");
  const adminNote =
    promoted?.role === FOUNDING_ROLE
      ? `${promoted.name ?? promoted.email} is now an admin.`
      : transferred?.role === FOUNDING_ROLE && !viewerIsFounding
        ? `${transferred.name ?? transferred.email} is now the admin, and you have stepped down.`
        : demoted && demoted.role !== FOUNDING_ROLE
          ? demoted.isYou
            ? `You are no longer an admin. You are now ${demoted.roleLabel}.`
            : `${demoted.name ?? demoted.email} is no longer an admin. They are now ${demoted.roleLabel}.`
          : null;

  // Moving the founding role is a different power from adding somebody, so it
  // is a different permission. The rank rule on top of it lives in the action.
  const canMoveAdmin = viewer.authz.can("member:role");

  const roleOptions = grantable.map((role) => (
    <option key={role.key} value={role.key}>
      {role.label}
    </option>
  ));
  const firstGrantable = grantable.find((r) => r.key === "SALES_HEAD")?.key ?? grantable[0]?.key ?? "";

  // Adding somebody sits beside the list, so it is in view from the header.
  const rail = team.canManage || byPhone || team.adminCount < 2;

  return (
    <>
      <PageHead
        title={
          <>
            Who is <span className="em">here</span>
          </>
        }
        meta={
          <>
            {team.members.length} {team.members.length === 1 ? "person" : "people"} ·{" "}
            {team.adminCount} {team.adminCount === 1 ? "admin" : "admins"} ·{" "}
            {viewer.state.org.displayName}
          </>
        }
        action={
          team.canManage ? (
            <a href="#invite" className="btn btn--ink team__jump">
              Invite someone
            </a>
          ) : null
        }
      />

      {imported !== null && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          <strong>
            {imported} invited
            {skipped > 0 ? `, ${skipped} already here` : ""}
            {refused > 0 ? `, ${refused} refused` : ""}
          </strong>
          {refused > 0 && <> Refused rows were not written. Fix them and import again.</>}
          {mailFailed > 0 && (
            <>
              {" "}
              {mailFailed} of the emails did not go out. Ask those people to sign in with their address.
            </>
          )}
        </div>
      )}

      <Flash
        text={adminNote}
        name={promoted ? "promoted" : transferred ? "transferred" : "demoted"}
        tone="info"
        style={{ marginBottom: 16 }}
      />

      <Flash text={error} name="error" style={{ marginBottom: 16 }} />

      <div className={rail ? "split team" : "stack team"}>
      <div className="split__main">
      {team.requests.length > 0 && (
        <section className="card">
          <div className="card__head">
            <h2>Asking to join</h2>
            <span className="pill pill--warn">{team.requests.length} waiting</span>
          </div>

          <div className="queue">
            {team.requests.map((r) => (
              <div key={r.id} className="qi" style={{ cursor: "default" }}>
                <span className="qi__mark qi__mark--info">
                  <Person size={15} />
                </span>
                <span className="qi__body">
                  <span className="qi__title">{r.name ?? r.email}</span>
                  <p className="qi__why">
                    {r.name ? `${r.email} · ` : ""}
                    {matchLabel(r.matchedOn)} · asked {onDate(r.requestedAt)}
                  </p>
                </span>
                <span className="qi__tail">
                  {team.canManage ? (
                    <>
                      <form action={approveJoinAction} className="inline-form">
                        <input type="hidden" name="requestId" value={r.id} />
                        <ScopedRole
                          roles={approvable.map((role) => ({
                            key: role.key,
                            label: role.label,
                            minKind: role.minKind,
                            at: role.at,
                          }))}
                          nodes={nodes}
                          defaultRoleKey="SALES_HEAD"
                          size="mini"
                        />
                        <button type="submit" className="btn btn--ink btn--sm">
                          Approve
                        </button>
                      </form>
                      <ConfirmAction
                        label="Reject"
                        title={`Turn down ${r.name ?? r.email}?`}
                        body={<p>They are not added to {viewer.state.org.displayName}, and their request is closed.</p>}
                        confirmLabel="Reject request"
                        action={rejectJoinAction}
                        fields={{ requestId: r.id }}
                        tone="ghost"
                        testId="reject-join"
                      />
                    </>
                  ) : (
                    <span className="pill pill--quiet">An admin decides this</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card" id="members">
        <div className="card__head">
          <h2>Members</h2>
          <span className="pill pill--quiet">{team.members.length}</span>
        </div>

        <Flash text={memberNote} name="member" tone="info" style={{ marginBottom: 12 }} />

        <div className="people">
          {team.members.map((m) => (
            <div key={m.membershipId} className="person">
              <span className="person__face">
                {(m.name ?? m.email).slice(0, 2).toUpperCase()}
              </span>
              <span className="person__id">
                <span className="person__name">
                  {m.name ?? m.email}
                  {m.isYou && <span className="pill pill--quiet">You</span>}
                </span>
                <span className="person__mail">{m.email}</span>
              </span>
              <span className="person__role">{m.roleLabel}</span>
              <span className="person__scope">
                <span className="person__place">
                  {m.scopeKind === "ORG" ? "Whole organisation" : m.scopeName}
                </span>
              </span>
              <span className="person__when">
                {m.status === "INVITED" ? (
                  <span className="pill pill--warn">Invited</span>
                ) : (
                  onDate(m.joinedAt)
                )}
              </span>

              {(() => {
                const { moveTo, remove } = controlsFor(m);
                const admin = canMoveAdmin && m.status === "ACTIVE";
                if (!admin && moveTo.length === 0 && !remove) return null;
                const who = m.name ?? m.email;
                const place = m.scopeKind === "ORG" ? "" : ` on ${m.scopeName}`;
                return (
                <span className="person__act">
                  {moveTo.length > 0 && (
                    <ConfirmAction
                      label="Change role"
                      title={`Change the role ${who} holds${place}?`}
                      body={
                        <>
                          <p>
                            {who} is {m.roleLabel}
                            {place} now.
                          </p>
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label htmlFor={`role-${m.membershipId}`}>Their role from now</label>
                            <select
                              id={`role-${m.membershipId}`}
                              name="role"
                              className="select-field"
                              defaultValue={moveTo[0].key}
                            >
                              {moveTo.map((r) => (
                                <option key={r.key} value={r.key}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      }
                      confirmLabel="Change role"
                      action={changeRoleAction}
                      fields={{ membershipId: m.membershipId }}
                      tone="ghost"
                      testId="change-role"
                    />
                  )}
                  {admin &&
                  (m.role === FOUNDING_ROLE ? (
                    // The last admin cannot be demoted, so the control is not
                    // offered rather than offered and refused.
                    team.adminCount > 1 && (
                      <ConfirmAction
                        label={m.isYou ? "Step down" : "Remove as admin"}
                        title={m.isYou ? "Step down as admin?" : `Take the admin role from ${m.name ?? m.email}?`}
                        body={
                          <>
                            <p>
                              {m.isYou
                                ? "You stay on the team in the role you pick, and can no longer manage admins or roles."
                                : `${m.name ?? m.email} stays on the team in the role you pick.`}
                            </p>
                            <div className="field" style={{ marginBottom: 0 }}>
                              <label htmlFor={`newRole-${m.membershipId}`}>
                                {m.isYou ? "Your role from now" : "Their role from now"}
                              </label>
                              <select
                                id={`newRole-${m.membershipId}`}
                                name="newRole"
                                className="select-field"
                                defaultValue={firstGrantable}
                              >
                                {roleOptions}
                              </select>
                            </div>
                          </>
                        }
                        confirmLabel={m.isYou ? "Step down" : "Remove as admin"}
                        action={demoteAdminAction}
                        fields={{ membershipId: m.membershipId }}
                        tone="ghost"
                        testId="demote-admin"
                      />
                    )
                  ) : (
                    <>
                      <ConfirmAction
                        label="Make admin"
                        title={`Make ${m.name ?? m.email} an admin?`}
                        body={
                          <p>
                            They can do everything here, including adding people, changing roles and
                            connecting accounts.
                          </p>
                        }
                        confirmLabel="Make admin"
                        action={promoteAdminAction}
                        fields={{ membershipId: m.membershipId }}
                        tone="ghost"
                        testId="promote-admin"
                      />
                      {viewerIsFounding && (
                        <ConfirmAction
                          label="Hand over admin"
                          title={`Hand the admin role to ${m.name ?? m.email}?`}
                          body={
                            <>
                              <p>
                                {m.name ?? m.email} becomes the admin. You stay on the team in the role
                                you pick, and can no longer manage admins or roles.
                              </p>
                              <div className="field" style={{ marginBottom: 0 }}>
                                <label htmlFor={`ownNewRole-${m.membershipId}`}>Your role from now</label>
                                <select
                                  id={`ownNewRole-${m.membershipId}`}
                                  name="ownNewRole"
                                  className="select-field"
                                  defaultValue={firstGrantable}
                                >
                                  {roleOptions}
                                </select>
                              </div>
                            </>
                          }
                          confirmLabel="Hand over and step down"
                          action={transferAdminAction}
                          fields={{ membershipId: m.membershipId }}
                          tone="risk"
                          testId="transfer-admin"
                        />
                      )}
                    </>
                  ))}
                  {remove && (
                    <ConfirmAction
                      label="Remove"
                      title={`Remove ${who}${place ? ` from ${m.scopeName}` : ""}?`}
                      body={
                        <p>
                          {who} is no longer {m.roleLabel}
                          {place}.
                          {(heldBy.get(m.userId) ?? 0) <= 1 &&
                            ` They can no longer open ${viewer.state.org.displayName}.`}
                        </p>
                      }
                      confirmLabel="Remove"
                      action={removeMemberAction}
                      fields={{ membershipId: m.membershipId }}
                      tone="risk"
                      testId="remove-member"
                    />
                  )}
                </span>
                );
              })()}
            </div>
          ))}
        </div>

      </section>

      {team.canManage && invites.length > 0 && (
        <section className="card" id="invited">
          <div className="card__head">
            <h2>Invited, not yet signed in</h2>
            <span className="pill pill--warn">{invites.length} waiting</span>
          </div>
          <div>
              {invites.map((i) => (
                <div key={i.membershipId} className="invited">
                  <span className="invited__mark">
                    <Clock size={14} />
                  </span>
                  <span className="invited__id">
                    <span className="invited__mail">{i.email}</span>
                    <span className="invited__meta">
                      {i.ageDays === 0
                        ? "invited today"
                        : `waiting ${i.ageDays} ${i.ageDays === 1 ? "day" : "days"}`}
                      {i.invitedByName ? ` · by ${i.invitedByName}` : ""}
                    </span>
                  </span>
                  <span className="invited__role">
                    <span className="pill pill--quiet">{i.roleLabel}</span>
                    {/* The role alone is half an answer once invites can land
                        below the root: Site Team on which tower. */}
                    {i.scopeKind !== "ORG" && (
                      <span className="pill pill--quiet">{i.scopeName}</span>
                    )}
                  </span>
                  <span className="invited__act">
                    <ConfirmAction
                      label="Withdraw"
                      title={`Withdraw the invite for ${i.email}?`}
                      body={<p>They can no longer sign in with it. You can invite them again later.</p>}
                      confirmLabel="Withdraw invite"
                      action={revokeInviteAction}
                      fields={{ membershipId: i.membershipId }}
                      tone="risk"
                      testId="withdraw-invite"
                    />
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}
      </div>

      {rail && (
      <aside className="split__side team__rail">
      {team.adminCount < 2 && (
        <section className="card team-warn">
          <span className="qi__mark qi__mark--risk">
            <Alert size={15} />
          </span>
          <div>
            <div className="qi__title">This organisation has one admin</div>
            <p className="qi__why">
              If this account is lost, nobody can manage the organisation. Add a second admin.
            </p>
          </div>
        </section>
      )}

      {team.canManage && (
        <section className="card" id="invite">
          <div className="card__head">
            <h2>Add someone</h2>
          </div>

          <Flash text={unsent} name="unsent" style={{ marginBottom: 12 }} />
          <Flash text={invited} name="invited" tone="info" style={{ marginBottom: 12 }} />
          <Flash text={address} name="address" tone="info" className="note--address" style={{ marginBottom: 12 }} />

          {/* A refusal comes back beside the form and keeps the address typed;
              a sent invite reloads the page, which empties it. */}
          <KeptForm action={inviteAction} className="invite">
            <input
              type="email"
              name="email"
              placeholder="name@company.com"
              aria-label="Email address"
              required
            />
            <ScopedRole
              roles={invitable.map((role) => ({
                key: role.key,
                label: role.label,
                minKind: role.minKind,
                at: role.at,
              }))}
              nodes={nodes}
              defaultRoleKey="SALES_HEAD"
            />
            <button type="submit" className="btn btn--ink">
              Send invite
              <ArrowUpRight size={14} />
            </button>
          </KeptForm>

          {nodes.length > 1 && <p className="team__hint">Pick the role first, then where they hold it.</p>}

          <div className="team__several">
            <ImportPeople
              grantable={invitable.map((r) => ({
                key: r.key,
                label: r.label,
                minKind: r.minKind,
                at: r.at,
              }))}
              allRoles={roles.map((r) => ({
                key: r.key,
                label: r.label,
                minKind: r.minKind,
              }))}
              nodes={nodes}
              // No preselection: rows that name no role are refused until
              // somebody chooses what they become.
              defaultRoleKey=""
              orgPrimaryDomain={viewer.state.org.primaryDomain}
            />
          </div>
        </section>
      )}

      {byPhone && (
        <section className="card" id="by-phone" data-by-phone>
          <div className="card__head">
            <h2>Add by phone</h2>
            {phonePeople.some((p) => p.status === "INVITED") && (
              <span className="pill pill--warn">
                {phonePeople.filter((p) => p.status === "INVITED").length} not signed in yet
              </span>
            )}
          </div>

          <Flash text={phoneAdded} name="phoneAdded" tone="info" style={{ marginBottom: 12 }} />

          <KeptForm action={invitePhoneAction} className="invite">
            <input type="text" name="name" placeholder="Their name" aria-label="Name" maxLength={120} required />
            <input
              type="tel"
              name="phone"
              placeholder="98200 45127"
              aria-label="Mobile number"
              inputMode="tel"
              autoComplete="off"
              required
            />
            <button type="submit" className="btn btn--ink" data-add-by-phone>
              Add
              <ArrowUpRight size={14} />
            </button>
          </KeptForm>

          {phonePeople.length > 0 && (
            <div style={{ marginTop: 20 }}>
              {phonePeople.map((p) => (
                <div key={p.membershipId} className="invited" data-phone-person={p.membershipId}>
                  <span className="invited__mark">
                    {p.status === "INVITED" ? <Clock size={14} /> : <Person size={14} />}
                  </span>
                  <span className="invited__id">
                    <span className="invited__mail">{p.name ?? "Agent"}</span>
                    <span className="invited__meta tnum">
                      {p.phone ? showPhone(p.phone) : ""} · {phonePersonState(p.status)}
                    </span>
                  </span>
                  <span className="invited__role">
                    <span className="pill pill--quiet">Agent</span>
                  </span>
                  {viewer.authz.can("member:remove") && (
                    <span className="invited__act">
                      <ConfirmAction
                        label={p.status === "INVITED" ? "Withdraw" : "Remove"}
                        title={p.status === "INVITED" ? `Withdraw the invite for ${p.name ?? "this person"}?` : `Remove ${p.name ?? "this person"}?`}
                        body={<p>They can no longer sign in to {viewer.state.org.displayName} with their phone.</p>}
                        confirmLabel={p.status === "INVITED" ? "Withdraw invite" : "Remove"}
                        action={removePhonePersonAction}
                        fields={{ membershipId: p.membershipId }}
                        tone="risk"
                        testId="remove-phone-person"
                      />
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      </aside>
      )}
      </div>
    </>
  );
}
