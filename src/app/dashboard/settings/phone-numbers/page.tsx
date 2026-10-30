import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listOrgRoles } from "@/lib/rbac";
import { loadPolicy } from "@/lib/mask";
import {
  VISIBILITIES,
  VISIBILITY_LABEL,
  shippedVisibility,
  thresholdOf,
  type Threshold,
} from "@/lib/mask-rules";
import { PATH, stageLabel } from "@/lib/lead-rules";
import { ALL_PERMISSIONS } from "@/lib/permissions";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { PageHead } from "@/components/shell/PageHead";
import { resetPhonePolicyAction, savePhonePolicyAction } from "@/app/actions/mask";
import { PolicyFields } from "./PolicyFields";
import "./phone.css";

/**
 * What each role sees of a buyer's number, and from which stage.
 *
 * Opens read-only: one row per role that works leads or visits, saying what
 * it sees. "Change" on a row opens that row alone as a form, because a
 * policy that is live should not sit under an open form.
 */
export default async function PhoneNumbersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("org:read")) redirect("/dashboard");
  const orgId = viewer.state.org.id;
  const canEdit = viewer.authz.can("org:manage");

  const [roles, rows, params] = await Promise.all([listOrgRoles(orgId), loadPolicy(orgId), searchParams]);
  const editing = canEdit && typeof params.role === "string" ? params.role : null;

  // Roles that see leads or visits at all. The rest see no buyer, so there is
  // nothing to set for them.
  const shown = roles.filter((r) => shippedVisibility(r.permissions) !== "HIDDEN");

  const describe = (t: Threshold) =>
    t.from
      ? [`${VISIBILITY_LABEL[t.before]} until ${stageLabel(t.from)}`, `${VISIBILITY_LABEL[t.after]} from ${stageLabel(t.from)}`]
      : [VISIBILITY_LABEL[t.before]];
  const tone = (label: string) =>
    label.startsWith("Full") ? "pill--blue" : label.startsWith("Hidden") ? "pill--quiet" : "pill--warn";

  return (
    <>
      <PageHead
        title={
          <>
            Buyer phone <span className="em">numbers</span>
          </>
        }
        meta="What each role sees of a buyer's number and email"
      />

      <Flash text={readFlash(params, "saved")} name="saved" tone="info" style={{ marginBottom: 16 }} />
      <Flash text={readFlash(params, "error")} name="error" style={{ marginBottom: 16 }} />

      <section className="card" id="policy" data-phone-policy>
        <div className="card__head">
          <h2>By role</h2>
          <span className="pill pill--quiet">{shown.length} roles</span>
        </div>

        <div className="pn-grid">
        {shown.map((r) => {
          const shipped = shippedVisibility(r.permissions);
          const t = thresholdOf(rows, r.key, "phone", shipped);
          const customised = rows.some((x) => x.role === r.key);
          const reveals = r.permissions.includes(ALL_PERMISSIONS) || r.permissions.includes("lead.phone:unmask");

          if (editing === r.key) {
            return (
              <form key={r.key} action={savePhonePolicyAction} className="pn-row pn-row--open" data-role={r.key}>
                <input type="hidden" name="role" value={r.key} />
                <div className="pn-row__id">
                  <p className="pn-row__name">{r.label}</p>
                  {reveals && <p className="pn-row__sub">Can reveal a masked number, one at a time</p>}
                </div>
                <PolicyFields
                  role={r.key}
                  visibilities={VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_LABEL[v] }))}
                  stages={PATH.slice(1).map((st) => ({ value: st, label: stageLabel(st) }))}
                  before={t.before}
                  from={t.from ?? ""}
                  after={t.after}
                />
                <div className="pn-row__acts">
                  <button type="submit" className="btn btn--ink btn--sm">
                    Save for {r.label}
                  </button>
                  <Link href="/dashboard/settings/phone-numbers#policy" className="btn btn--ghost btn--sm">
                    Cancel
                  </Link>
                  {customised && (
                    <button type="submit" formAction={resetPhonePolicyAction} className="btn btn--ghost btn--sm">
                      Back to what we ship
                    </button>
                  )}
                </div>
              </form>
            );
          }

          return (
            <div key={r.key} className="pn-row" data-role={r.key}>
              <div className="pn-row__id">
                <p className="pn-row__name">{r.label}</p>
                {reveals && <p className="pn-row__sub">Can reveal a masked number, one at a time</p>}
              </div>
              <div className="pn-row__pills">
                {describe(t).map((d) => (
                  <span key={d} className={`pill ${tone(d)}`}>
                    {d}
                  </span>
                ))}
                {customised && <span className="pill pill--quiet">Changed</span>}
              </div>
              {canEdit && (
                <Link
                  href={`/dashboard/settings/phone-numbers?role=${encodeURIComponent(r.key)}#policy`}
                  className="btn btn--ghost btn--sm"
                >
                  Change
                </Link>
              )}
            </div>
          );
        })}
        </div>
      </section>
    </>
  );
}
