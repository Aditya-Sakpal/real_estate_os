import Link from "next/link";
import { resolveBrain } from "@/lib/brain";
import { asList, fieldsIn, groupsFor, showValue } from "@/lib/brain-rules";
import type { ScopeKind } from "@/lib/roles";
import { ArrowLeft } from "@/components/icons";

/**
 * A channel partner's linked project or tower: what the developer signed,
 * read through the link, and nothing to edit. The developer is the only one
 * who can change it, and the page says whose it is.
 */
export async function LinkedBrain({
  orgId,
  node,
  developer,
  backHref,
}: {
  orgId: string;
  node: { id: string; name: string; kind: ScopeKind };
  developer: string;
  backHref: string;
}) {
  const brain = await resolveBrain(orgId, node.id);
  const values = brain?.values ?? {};
  const groups = groupsFor(node.kind).map((g) => ({
    ...g,
    rows: fieldsIn(g.key)
      .map((f) => ({ f, text: f.type === "LIST" ? asList(values[f.key]).join(" · ") : showValue(f, values[f.key]) }))
      .filter((r) => r.text),
  }));
  const any = groups.some((g) => g.rows.length);

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href={backHref} className="backlink">
            <ArrowLeft size={14} />
            Back to project
          </Link>
          <h1 style={{ marginTop: 4 }}>
            What we <span className="em">say</span> about {node.name}
          </h1>
          <p className="sub" style={{ marginTop: 6 }}>
            {brain ? `From ${developer}'s signed facts. Only ${developer} can change them.` : `${developer} has not empanelled you for this project today.`}
          </p>
        </div>
      </div>

      {brain && !any && (
        <section className="card">
          <p className="sub">{developer} has not published facts for this project yet.</p>
        </section>
      )}

      {groups
        .filter((g) => g.rows.length)
        .map((g) => (
          <section key={g.key} className="card" style={{ marginBottom: 14 }} data-linked-group={g.key}>
            <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>{g.label}</h2>
            <dl style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr", gap: "8px 16px", margin: 0 }}>
              {g.rows.map((r) => (
                <div key={r.f.key} style={{ display: "contents" }}>
                  <dt style={{ color: "var(--ink-mute)", fontSize: 13 }}>{r.f.label}</dt>
                  <dd style={{ margin: 0, fontSize: 14 }}>{r.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
    </>
  );
}
