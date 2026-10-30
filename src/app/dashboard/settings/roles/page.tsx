import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listOrgRoles, type ResolvedRole } from "@/lib/rbac";
import { FOUNDING_ROLE, type ScopeKind } from "@/lib/roles";
import { PERMISSION_GROUPS, PERMISSIONS, type PermissionDef } from "@/lib/permissions";
import { readFlash } from "@/lib/flash";
import { saveRoleAction, resetRoleAction, deleteRoleAction } from "@/app/actions/roles";
import { KeptForm } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { Shield, Plus, Check } from "@/components/icons";
import "./roles.css";

/** Only the permissions something in code asks for. A `future` one grants nothing yet. */
const SHOWN = PERMISSIONS.filter((p) => !p.future);
const HIDDEN = PERMISSIONS.filter((p) => p.future);
const FORM_ID = "roleform";

const LEVELS: { value: ScopeKind; label: string; why: string }[] = [
  { value: "ORG", label: "Whole organisation", why: "Anyone holding it works across every project." },
  { value: "ENTITY", label: "One entity or SPV", why: "Scoped to a single legal entity." },
  { value: "REGION", label: "One region or city", why: "Scoped to a city and everything under it." },
  { value: "PROJECT", label: "One project", why: "Scoped to a single project and its phases." },
  { value: "PHASE", label: "One phase or tower", why: "The narrowest scope there is." },
];

const NEW = "new";

function sourceTag(role: ResolvedRole) {
  if (role.source === "CUSTOM") return { text: "Your role", cls: "pill--blue" };
  if (role.source === "OVERRIDE") return { text: "Edited", cls: "pill--blue" };
  return { text: "As shipped", cls: "pill--quiet" };
}

function PermissionRow({
  permission,
  checked,
  fixed,
}: {
  permission: PermissionDef;
  checked: boolean;
  fixed: boolean;
}) {
  return (
    <label className={fixed ? "perm perm--fixed" : "perm"}>
      <input
        type="checkbox"
        name="permissions"
        value={permission.key}
        defaultChecked={checked}
        disabled={fixed}
      />
      <span className="perm__label">
        {permission.label}
        {permission.sensitive && <span className="perm__flag perm__flag--care">Care</span>}
      </span>
      <span className="perm__detail">{permission.detail}</span>
    </label>
  );
}

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("role:read")) redirect("/dashboard");

  const canManage = viewer.authz.can("role:manage");
  const roles = await listOrgRoles(viewer.state.org.id);
  const q = await searchParams;
  const wanted = typeof q.role === "string" ? q.role : undefined;
  const error = readFlash(q, "error");
  const saved = readFlash(q, "saved");

  const creating = wanted === NEW && canManage;
  const selected = creating
    ? undefined
    : roles.find((r) => r.key === wanted) ?? roles.find((r) => r.key === FOUNDING_ROLE) ?? roles[0];

  const shipped = roles.filter((r) => r.source !== "CUSTOM");
  const invented = roles.filter((r) => r.source === "CUSTOM");

  const held = new Set(selected?.permissions ?? []);
  const isFounding = selected?.key === FOUNDING_ROLE;
  const locked = isFounding || !canManage;

  const item = (r: ResolvedRole) => (
    <Link
      key={r.key}
      href={`/dashboard/settings/roles?role=${encodeURIComponent(r.key)}`}
      className={`rolelist__item${!creating && selected?.key === r.key ? " rolelist__item--on" : ""}`}
    >
      <span className="rolelist__top">
        <span className="rolelist__name">{r.label}</span>
        <span className="rolelist__count">
          {r.memberCount > 0 ? r.memberCount : ""}
        </span>
      </span>
      <span className="rolelist__note">
        {r.source === "OVERRIDE" ? "Edited · " : ""}
        {r.description}
      </span>
    </Link>
  );

  return (
    <>
      <div style={{ padding: "20px 2px 18px" }}>
        <h1>
          What each role <span className="em">may do</span>
        </h1>
        <p className="sub" style={{ marginTop: 6 }}>
          {roles.length} roles · {viewer.state.org.displayName}
          {canManage ? "" : " · you can see these but not change them"}
        </p>
      </div>

      <Flash text={error} name="error" style={{ marginBottom: 16 }} />
      <Flash text={error ? null : saved} name="saved" tone="info" style={{ marginBottom: 16 }} />

      <div className="roles">
        <div className="card roles__catalog">
          <div className="rolelist__sep" style={{ marginTop: 0 }}>
            Roles we ship
          </div>
          <nav className="rolelist">{shipped.map(item)}</nav>

          {invented.length > 0 && (
            <>
              <div className="rolelist__sep">Roles you wrote</div>
              <nav className="rolelist">{invented.map(item)}</nav>
            </>
          )}

          {canManage && (
            <Link
              href={`/dashboard/settings/roles?role=${NEW}`}
              className="rolelist__new"
              style={creating ? { borderColor: "var(--blue-line)", color: "var(--blue-deep)" } : undefined}
            >
              <Plus size={15} />
              New role
            </Link>
          )}
        </div>

        <div className="card roles__editor">
          {isFounding ? (
            <>
              <div className="roleform__head">
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.022em", margin: 0 }}>
                    {selected?.label}
                  </h2>
                  <p className="sub" style={{ marginTop: 4 }}>
                    {selected?.description}
                  </p>
                  <div className="roleform__tags">
                    <span className="pill pill--quiet">Fixed</span>
                    <span className="pill pill--quiet">
                      {selected?.memberCount} {selected?.memberCount === 1 ? "person" : "people"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rolelock">
                <span className="rolelock__mark">
                  <Shield size={17} />
                </span>
                <div>
                  <p style={{ margin: 0, fontSize: 13.5, fontWeight: 570 }}>
                    This role cannot be edited.
                  </p>
                  <p className="sub" style={{ marginTop: 4 }}>
                    This role always has every permission. Keep two admins.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
            {/* Keyed by the role, so moving to another role starts a fresh
                form: ticks left from the last one were saved onto the next. */}
            <KeptForm key={creating ? NEW : selected?.key} id={FORM_ID} action={saveRoleAction}>
              <input type="hidden" name="key" value={creating ? "" : selected?.key ?? ""} />
              {/* Not shown, because nothing asks for them yet, and kept, so a
                  save does not quietly drop one this role already has. */}
              {!locked &&
                HIDDEN.filter((p) => held.has(p.key)).map((p) => (
                  <input key={p.key} type="hidden" name="permissions" value={p.key} />
                ))}

              <div className="roleform__head">
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.022em", margin: 0 }}>
                    {creating ? "A role of your own" : selected?.label}
                  </h2>
                  <p className="sub" style={{ marginTop: 4 }}>
                    {creating
                      ? "Name it, choose the level it works at, and tick what it may do."
                      : "Tick what it may do. People holding it pick up the change immediately."}
                  </p>
                  {!creating && selected && (
                    <div className="roleform__tags">
                      <span className={`pill ${sourceTag(selected).cls}`}>
                        {sourceTag(selected).text}
                      </span>
                      <span className="pill pill--quiet">
                        {selected.memberCount}{" "}
                        {selected.memberCount === 1 ? "person" : "people"}
                      </span>
                      {selected.canDelegate && (
                        <span className="pill pill--warn">Can add people</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="roleform__pair">
                <div className="field">
                  <label htmlFor="role-label">Name</label>
                  <input
                    id="role-label"
                    type="text"
                    name="label"
                    defaultValue={creating ? "" : selected?.label ?? ""}
                    placeholder="Regional Sales Head"
                    maxLength={60}
                    required
                    disabled={locked}
                  />
                </div>

                <div className="field">
                  <label htmlFor="role-kind">Works at</label>
                  <select
                    id="role-kind"
                    name="minKind"
                    className="select-field"
                    defaultValue={creating ? "ORG" : selected?.minKind ?? "ORG"}
                    disabled={locked}
                  >
                    {LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="role-desc">What it is for</label>
                <input
                  id="role-desc"
                  type="text"
                  name="description"
                  defaultValue={creating ? "" : selected?.description ?? ""}
                  placeholder="One line, so the next admin knows who to give it to."
                  maxLength={200}
                  disabled={locked}
                />
              </div>

              {PERMISSION_GROUPS.map((group) => {
                const inGroup = SHOWN.filter((p) => p.group === group.key);
                if (!inGroup.length) return null;
                return (
                  <div className="permgroup" key={group.key}>
                    <div className="permgroup__head">
                      <div className="permgroup__name">{group.label}</div>
                      <div className="permgroup__why">{group.detail}</div>
                    </div>
                    <div className="perms">
                      {inGroup.map((p) => (
                        <PermissionRow
                          key={p.key}
                          permission={p}
                          checked={held.has(p.key)}
                          fixed={locked}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

            </KeptForm>

              {/* Outside the form: Reset and Delete ask first, and a dialog's
                  own form cannot sit inside another form. Save still belongs
                  to it through the form attribute. */}
              {canManage && (
                <div className="roleform__foot">
                  <button type="submit" form={FORM_ID} className="btn btn--ink">
                    <Check size={14} />
                    {creating ? "Create role" : "Save changes"}
                  </button>
                  <span className="roleform__spacer" />
                  {!creating && selected?.source === "OVERRIDE" && (
                    <ConfirmAction
                      label="Reset to what we ship"
                      title={`Reset ${selected.label} to what we ship?`}
                      body={
                        <p>
                          Your changes are discarded. Anyone holding it goes back to the permissions it
                          shipped with.
                        </p>
                      }
                      confirmLabel="Reset role"
                      action={resetRoleAction}
                      fields={{ key: selected.key }}
                      tone="ghost"
                      size="md"
                      testId="reset-role"
                    />
                  )}
                  {!creating && selected?.source === "CUSTOM" &&
                    (selected.memberCount > 0 ? (
                      <span className="sub">
                        Move its {selected.memberCount === 1 ? "one person" : `${selected.memberCount} people`} to
                        another role to delete it.
                      </span>
                    ) : (
                      <ConfirmAction
                        label="Delete this role"
                        title={`Delete ${selected.label}?`}
                        body={<p>The role is removed for good. Nobody holds it now.</p>}
                        confirmLabel="Delete role"
                        action={deleteRoleAction}
                        fields={{ key: selected.key }}
                        tone="risk"
                        size="md"
                        testId="delete-role"
                      />
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
