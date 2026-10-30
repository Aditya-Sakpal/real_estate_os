import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { withTenant } from "@/lib/db";
import { PageHead } from "@/components/shell/PageHead";
import { Library as LibraryIcon } from "@/components/icons";
import { listCompetitorAds, readsThisMonth, type CompetitorAdView } from "@/lib/competitor";
import { PLATFORM_LABEL, COMPETITOR_CAPS, MAX_PICTURE_BYTES, MAX_VIDEO_BYTES } from "@/lib/competitor-rules";
import { learningFor, showValue } from "@/lib/learning";
import { runningDays, type Dim } from "@/lib/learning-rules";
import { removeCompetitorAdAction } from "@/app/actions/learning";
import { AddAd, WeightForm, RemoveButton } from "./MarketTools";
import "./market.css";

/**
 * Competitor ads: what the team saved, and the library Sales Desk keeps for
 * their cities. Each is read into the same ingredients our own ads are
 * scored by, and counted in what the next creative is made from.
 *
 * Reading needs `campaign:read`. Saving and removing need `campaign:create`
 * where the ad is saved, and the weight needs it at the organisation.
 */

type Search = Promise<Record<string, string | string[] | undefined>>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const showDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ""}`;
};

export default async function MarketPage({ searchParams }: { searchParams: Search }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const tab = q.view === "library" ? "library" : "ours";

  const [ads, nodes, root] = await Promise.all([
    listCompetitorAds(orgId, viewer.authz.scopesFor("campaign:read")),
    withTenant(orgId, (sql) => sql<{ id: string; kind: "PROJECT" | "PHASE"; name: string; path: string; under: string | null; project_path: string | null }[]>`
      SELECT n.id, n.kind, n.name, n.path::text AS path, p.name AS under,
             CASE WHEN n.kind = 'PROJECT' THEN n.path::text ELSE p.path::text END AS project_path
      FROM scope_nodes n LEFT JOIN scope_nodes p ON p.id = n.parent_id AND n.kind = 'PHASE'
      WHERE n.org_id = ${orgId} AND n.kind IN ('PROJECT', 'PHASE')
      ORDER BY coalesce(p.name, n.name), n.kind DESC, n.name`),
    withTenant(orgId, (sql) => sql<{ id: string; path: string }[]>`
      SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`).then((r) => r[0] ?? null),
  ]);
  const writable = nodes.filter((n) => viewer.authz.canAt("campaign:create", n.path));
  const mayAdd = writable.length > 0;
  const mayWeigh = !!root && viewer.authz.canAt("campaign:create", root.path);
  const projectPaths = [...new Set(writable.map((n) => n.project_path).filter((p): p is string => !!p))];
  const [used, learning] = await Promise.all([
    Promise.all(projectPaths.map(async (p) => [p, await readsThisMonth(orgId, p)] as const)),
    root ? learningFor(orgId, root.id) : null,
  ]);
  const usedBy = new Map(used);
  const places = writable.map((n) => {
    const u = n.project_path ? usedBy.get(n.project_path) : undefined;
    return {
      id: n.id,
      label: n.under ? `${n.under} · ${n.name}` : n.name,
      pictures: u?.pictures ?? 0,
      videos: u?.videos ?? 0,
    };
  });

  const list = tab === "library" ? ads.market : ads.ours;
  const leans = (learning?.playbook ?? []).filter((l) => l.tone === "market").slice(0, 3);

  return (
    <>
      <PageHead
        back={{ label: "Library", href: "/dashboard/library" }}
        title={
          <>
            What competitors <span className="em">run</span>
          </>
        }
        meta={`${ads.ours.length} saved by your team · ${ads.market.length} in Sales Desk's library`}
        action={mayAdd ? <AddAd places={places} caps={COMPETITOR_CAPS} maxBytes={{ picture: MAX_PICTURE_BYTES, video: MAX_VIDEO_BYTES }} /> : undefined}
      />

      {leans.length > 0 && (
        <section className="ws-dark mk-leans" aria-label="What competitors lean on">
          <span className="ws-dark__label">Competitors near you lean on</span>
          <ul className="mk-leans__list">
            {leans.map((l) => (
              <li key={`${l.dim}|${l.value}`}>{l.text}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="mk-bar">
        <div className="seg" role="group" aria-label="Whose">
          <Link href="/dashboard/library/market" className="seg__opt mk-seg" aria-pressed={tab === "ours"}>
            Saved by your team <span className="tnum">{ads.ours.length}</span>
          </Link>
          <Link href="/dashboard/library/market?view=library" className="seg__opt mk-seg" aria-pressed={tab === "library"}>
            Sales Desk&apos;s library <span className="tnum">{ads.market.length}</span>
          </Link>
        </div>
        {learning && (
          <WeightForm value={learning.settings.marketWeight} editable={mayWeigh} />
        )}
      </div>

      {list.length === 0 ? (
        <section className="card">
          <div className="empty" style={{ padding: "34px 20px" }}>
            <div className="empty__mark">
              <LibraryIcon size={19} />
            </div>
            {tab === "library"
              ? "Nothing in Sales Desk's library for your cities yet."
              : mayAdd
                ? "No competitor ads saved yet. Save one you saw on Facebook, Instagram, Google or a portal."
                : "No competitor ads saved yet."}
          </div>
        </section>
      ) : (
        <ul className="mk-grid">
          {list.map((ad) => (
            <Tile key={ad.id} ad={ad} removable={tab === "ours" && !!ad.path && viewer.authz.canAt("campaign:create", ad.path)} />
          ))}
        </ul>
      )}
    </>
  );
}

const PILL_DIMS: Dim[] = ["angle", "format", "picture"];

function Tile({ ad, removable }: { ad: CompetitorAdView; removable: boolean }) {
  const days = runningDays(ad.runningSince, ad.seenOn);
  const where = [ad.projectName, ad.locality].filter(Boolean).join(" · ");
  return (
    <li className="card mk-tile">
      <div className="mk-tile__media">
        {ad.hasPoster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/dashboard/library/market/poster/${ad.id}${ad.source === "MARKET" ? "?s=market" : ""}`} alt="" loading="lazy" />
        ) : (
          <span className="mk-tile__none">No picture</span>
        )}
        <span className="pill mk-tile__age tnum">
          {days !== null ? `Running ${days} ${days === 1 ? "day" : "days"}` : `Seen ${showDay(ad.seenOn)}`}
        </span>
      </div>
      <div className="mk-tile__body">
        <p className="mk-tile__who">{ad.competitor}</p>
        <p className="mk-tile__where">{where || PLATFORM_LABEL[ad.platform]}</p>
        <div className="mk-tile__pills">
          {ad.readState === "FAILED" ? (
            <span className="pill pill--warn">Could not be read</span>
          ) : (
            PILL_DIMS.map((d) => {
              const v = ad.tags[d];
              return typeof v === "string" ? (
                <span key={d} className={`pill ${d === "angle" ? "pill--blue" : "pill--quiet"}`}>
                  {cap(showValue(d, v))}
                </span>
              ) : null;
            })
          )}
          {ad.flags.length > 0 && <span className="pill pill--risk">A claim you can&apos;t make</span>}
        </div>
      </div>
      <div className="mk-tile__foot">
        <span>
          {PLATFORM_LABEL[ad.platform]}
          {ad.comparedWith ? ` · for ${ad.comparedWith}` : ""}
        </span>
        {removable && (
          <form action={removeCompetitorAdAction}>
            <input type="hidden" name="id" value={ad.id} />
            <RemoveButton who={ad.competitor} />
          </form>
        )}
      </div>
    </li>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
