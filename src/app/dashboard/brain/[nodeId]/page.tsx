import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { inReach } from "@/lib/grant-rules";
import { getViewer } from "@/lib/console";
import { loadBrain } from "@/lib/brain";
import { documentSummary, sourcesOf } from "@/lib/extract";
import { onDate } from "@/lib/team";
import { readFlash } from "@/lib/flash";
import {
  asList,
  fieldByKey,
  fieldsIn,
  groupsFor,
  showValue,
  type FieldDef,
  type GroupState,
  type InheritedBrain,
} from "@/lib/brain-rules";
import {
  brainDraftAction,
  openDraftAction,
  signAllAction,
  signBrainGroupAction,
} from "@/app/actions/brain";
import { VersionPicker } from "./VersionPicker";
import { LinkedBrain } from "./LinkedBrain";
import { linkedTo } from "@/lib/linked";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { Alert, Check, ArrowLeft, ArrowUpRight } from "@/components/icons";
import "./brain.css";

/**
 * One node's Project Brain.
 *
 * Two modes, and the default is the safe one. Arriving shows the live version,
 * read-only: what the company currently says, with nothing to accidentally
 * change. Editing is a decision somebody takes, and it opens the draft.
 *
 * The screen is organised by signature group, because the group is what a
 * person puts their name to. Every control is gated on its own permission: a
 * finance approver sees the claims, because reading what the company says is
 * not a privilege, but the button that signs it is not theirs.
 */
export default async function BrainPage({
  params,
  searchParams,
}: {
  params: Promise<{ nodeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  // The page's own gate. Filtering the rail is presentation; this is what
  // answers somebody typing the URL.
  if (!viewer.authz.can("brain:read")) redirect("/dashboard");

  const { nodeId } = await params;
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // What an action said, only when it was ours to say. Anything else in the
  // address is ignored rather than printed.
  const error = readFlash(q, "error");
  const note = readFlash(q, "note");

  const wanted = Number(one(q.v));
  const [brain, docs] = await Promise.all([
    loadBrain(viewer.state.org.id, nodeId, Number.isInteger(wanted) && wanted > 0 ? wanted : undefined),
    documentSummary(viewer.state.org.id, nodeId),
  ]);
  // Holding the key somewhere is not holding it here: a node outside the
  // viewer's reach (a tower of theirs, or the project above it) is not found.
  if (!brain || !inReach(brain.node.path, viewer.authz.scopesFor("brain:read"))) notFound();
  // A channel partner's project added from a developer: the developer's facts, read-only.
  const linked = await linkedTo(viewer.state.org.id, brain.node.id);
  if (linked) {
    return (
      <LinkedBrain
        orgId={viewer.state.org.id}
        node={{ id: brain.node.id, name: brain.node.name, kind: brain.node.kind }}
        developer={linked.developer}
        backHref={brain.node.projectId ? `/dashboard/projects/${brain.node.projectId}` : "/dashboard/projects"}
      />
    );
  }

  const mayEdit = viewer.authz.canAt("brain:edit", brain.node.path);
  const mayPublish = viewer.authz.canAt("brain:publish", brain.node.path);
  // Only the groups this node actually has: a project holds no registration,
  // and neither does an exempt phase, so neither is asked for one.
  const groups = groupsFor(brain.node.kind, brain.node.exempt);
  const inherited = brain.inherited;
  const inheritsFrom = [
    ...new Set([
      ...Object.values(inherited.from),
      ...Object.values(inherited.lines).flatMap((ls) => ls.map((l) => l.from)),
    ]),
  ];
  const maySignAny = groups.some((g) => viewer.authz.canAt(g.approves, brain.node.path));

  const { draft, published } = brain;

  // An approver is here to look at the draft, not at what is already live:
  // the three people who sign are usually the three who cannot edit, and
  // opening them on last month's published version would hide the thing they
  // were asked to come and do. Anyone else opens on the live version.
  const selected =
    !one(q.v) && draft && (mayEdit || maySignAny) ? draft : brain.selected;

  // Editing means the draft, always. Asking to edit while looking at a
  // published version shows the draft instead, because a published version
  // cannot be changed and pretending otherwise would waste somebody's typing.
  const editing = one(q.edit) === "1" && mayEdit && draft !== null;
  const shown = editing ? draft : selected;
  const backHref = brain.node.projectId
    ? `/dashboard/projects/${brain.node.projectId}`
    : "/dashboard/projects";
  const unsigned = brain.groups.filter((g) => g.required);
  // A draft identical to the live version has nothing to publish, and saying
  // "ready to publish" when the server would refuse is how a button teaches
  // somebody not to trust the screen.
  const nothingChanged = published !== null && brain.groups.every((g) => g.unchanged);
  // Signature state belongs to the draft, so only show it when the draft is
  // what is on screen. On a published version it would describe a different
  // set of values.
  const showsDraft = shown !== null && draft !== null && shown.version === draft.version;
  // Where each value on screen was read from, when a document said it.
  const sources = await sourcesOf(viewer.state.org.id, shown?.id);
  const docsHref = `/dashboard/brain/${brain.node.id}/documents`;

  // One press for everything this person may sign. Each section still gets
  // its own signature under its own permission; the press only saves them
  // walking to three cards and back to a Publish button that was disabled
  // until they had. When what they can sign is all that is left, and they may
  // publish, the same press publishes, and the label says so.
  const waiting = showsDraft ? brain.groups.filter((s) => s.required) : [];
  // A section holding a value read from a document that nobody has checked
  // cannot be signed yet, so it is not offered: the server would refuse it.
  const unchecked = new Set(docs.unreviewedKeys.map((k) => fieldByKey(k)?.group).filter(Boolean));
  const mine = waiting.filter((s) => {
    const def = groups.find((d) => d.key === s.group);
    return def ? viewer.authz.canAt(def.approves, brain.node.path) && !unchecked.has(s.group) : false;
  });
  const signAll =
    mine.length === 0 || !draft
      ? null
      : (() => {
          const publish = mine.length === waiting.length && mayPublish && !nothingChanged;
          const single = mine.length === 1 ? groups.find((d) => d.key === mine[0].group) : null;
          const what = single ? single.inline : `${mine.length} sections`;
          return {
            publish,
            label: publish ? `Sign and publish version ${draft.version}` : `Sign ${what}`,
          };
        })();

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href={backHref} className="backlink">
            <ArrowLeft size={14} />
            Back to project
          </Link>
          <h1 style={{ marginTop: 4 }}>
            What we <span className="em">say</span> about {brain.node.name}
          </h1>
          <p className="sub" style={{ marginTop: 6 }}>
            {shown
              ? editing
                ? `Editing draft ${shown.version}`
                : shown.state === "PUBLISHED"
                  ? `Live since ${shown.publishedAt ? onDate(shown.publishedAt) : "today"}${
                      shown.publishedByName ? `, published by ${shown.publishedByName}` : ""
                    }`
                  : shown.state === "DRAFT"
                    ? "Draft, not published"
                    : `Replaced${shown.publishedAt ? ` after ${onDate(shown.publishedAt)}` : ""}`
              : inheritsFrom.length
                ? `Nothing set here yet. Uses ${inheritsFrom.join(" and ")}.`
                : "Nothing here yet"}
            {brain.node.exempt && " · Exempt from registration"}
          </p>
        </div>

        <div className="pagehead__acts">
          {(brain.node.kind === "PROJECT" || brain.node.kind === "PHASE") && (
            <Link href={docsHref} className="btn btn--ghost btn--sm" data-documents="">
              Documents
              {docs.toCheck > 0 && <span className="pill pill--blue">{docs.toCheck} to check</span>}
            </Link>
          )}
          {(brain.node.kind === "PROJECT" || brain.node.kind === "PHASE") && (
            <Link href={`/dashboard/brain/${brain.node.id}/words`} className="btn btn--ghost btn--sm" data-words="">
              Pronunciation
            </Link>
          )}
          {brain.versions.length > 0 && (
            <VersionPicker
              nodeId={brain.node.id}
              versions={brain.versions.map((v) => ({
                version: v.version,
                state: v.state,
                publishedAt: v.publishedAt,
              }))}
              current={shown?.version ?? brain.versions[0].version}
            />
          )}

          {editing ? (
            <>
              {/* No "Done". It sat beside Save and left the editor WITHOUT
                  saving, which is the same trap the brief's Done was. The
                  back link leaves; these two keep the work. */}
              {/* Outside the form, submitting it by id: the controls belong at
                  the top where they are found, and forms cannot nest. Every
                  one of them sends the whole draft, so what is on screen is
                  saved before anything is signed or published; the button's
                  own value says which it was. */}
              <button
                type="submit"
                form="braindraft"
                name="intent"
                value="save"
                className="btn btn--ghost btn--sm"
              >
                Save draft
              </button>
              {signAll && (
                <button
                  type="submit"
                  form="braindraft"
                  name="intent"
                  value={signAll.publish ? "signAllPublish" : "signAll"}
                  className="btn btn--ink btn--sm"
                  data-sign-all=""
                >
                  {signAll.label}
                  <ArrowUpRight size={13} />
                </button>
              )}
              {mayPublish && !signAll?.publish && (
                <button
                  type="submit"
                  form="braindraft"
                  name="intent"
                  value="publish"
                  className="btn btn--ink btn--sm"
                  disabled={unsigned.length > 0 || nothingChanged}
                  data-publish=""
                >
                  Publish version {draft?.version}
                  <ArrowUpRight size={13} />
                </button>
              )}
            </>
          ) : (
            <>
              {mayEdit && (
                <form action={openDraftAction}>
                  <input type="hidden" name="nodeId" value={brain.node.id} />
                  <button
                    type="submit"
                    className={`btn ${signAll ? "btn--ghost" : "btn--ink"} btn--sm`}
                    data-edit=""
                  >
                    {draft ? `Continue draft ${draft.version}` : published ? "Edit" : "Set it up"}
                    <ArrowUpRight size={13} />
                  </button>
                </form>
              )}
              {/* A reviewer who cannot edit signs what is stored. The hash of
                  every section rides along, so an edit made underneath them is
                  refused rather than signed blind. */}
              {signAll && (
                <form action={signAllAction.bind(null, signAll.publish)}>
                  <input type="hidden" name="nodeId" value={brain.node.id} />
                  {mine.map((s) => (
                    <input key={s.group} type="hidden" name={`hash_${s.group}`} value={s.hash} />
                  ))}
                  <button type="submit" className="btn btn--ink btn--sm" data-sign-all="">
                    {signAll.label}
                    <ArrowUpRight size={13} />
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>

      <Flash text={error} name="error" tone="risk" style={{ marginBottom: 16 }} />
      <Flash text={error ? null : note} name="note" tone="info" style={{ marginBottom: 16 }} />

      {docs.unreviewedInDraft > 0 && (
        <div className="note note--warn brainbanner" style={{ marginBottom: 16 }} data-unreviewed="">
          <span className="brainbanner__body">
            {docs.unreviewedInDraft === 1
              ? "One value in this draft was read from a document and has not been checked."
              : `${docs.unreviewedInDraft} values in this draft were read from documents and have not been checked.`}
          </span>
          <Link href={docsHref} className="btn btn--ink btn--sm">
            Check them
            <ArrowUpRight size={13} />
          </Link>
        </div>
      )}

      {editing && draft && published && nothingChanged && (
        <div className="note note--info" style={{ marginBottom: 16 }}>
          Nothing has changed from version {published.version} yet.
        </div>
      )}
      {editing && draft && published && !nothingChanged && unsigned.length === 0 && (
        <div className="note note--info" style={{ marginBottom: 16 }}>
          Everything that changed is signed. Publishing replaces version{" "}
          {published.version}.
        </div>
      )}

      <Cards editing={editing} nodeId={brain.node.id}>
        {groups.map((g, i) => {
          const state = brain.groups.find((s) => s.group === g.key)!;
          const fields = fieldsIn(g.key);
          const maySign = viewer.authz.canAt(g.approves, brain.node.path);
          // Read-only, the sections sit two across; an odd one out at the end
          // (the claims, on a registered tower) takes the whole row.
          const wide = !editing && groups.length % 2 === 1 && i === groups.length - 1;

          return (
            <section className={`card braincard${wide ? " braincard--wide" : ""}`} key={g.key}>
              <div className="card__head">
                <h2>{g.label}</h2>
                {showsDraft && <GroupPill state={state} />}
              </div>

              <div className={editing ? "brainform" : "fieldgrid brainfacts"}>
                {fields.map((f) =>
                  editing ? (
                    <Field
                      key={f.key}
                      def={f}
                      value={draft?.values[f.key] ?? null}
                      inherited={inheritedFor(inherited, f)}
                      source={sources[f.key] ? { ...sources[f.key], href: docsHref } : null}
                    />
                  ) : (
                    <ReadOnly
                      key={f.key}
                      def={f}
                      value={shown?.values[f.key] ?? null}
                      inherited={inheritedFor(inherited, f)}
                      source={sources[f.key] ? { ...sources[f.key], href: docsHref } : null}
                    />
                  ),
                )}
              </div>

              {showsDraft && (
                <div className="brainsign">
                  <Status state={state} />
                  {maySign && !state.signed && !state.unchanged && unchecked.has(g.key) && (
                    <Link href={docsHref} className="btn btn--ghost btn--sm" data-check-first={g.key}>
                      Check the values read from documents first
                    </Link>
                  )}
                  {maySign &&
                    !state.signed &&
                    !state.unchanged &&
                    !unchecked.has(g.key) &&
                    (editing ? (
                      // Inside the page's one form, so signing saves what is
                      // on screen before it attests to anything.
                      <button
                        type="submit"
                        name="intent"
                        value={`sign:${g.key}`}
                        data-sign={g.key}
                        className="btn btn--ink btn--sm"
                      >
                        Sign {g.inline}
                      </button>
                    ) : (
                      // A reviewer who cannot edit signs what is stored. The
                      // hash is what they were shown, so an edit underneath
                      // them is refused rather than signed blind.
                      <form action={signBrainGroupAction.bind(null, g.key)}>
                        <input type="hidden" name="nodeId" value={brain.node.id} />
                        <input type="hidden" name="hash" value={state.hash} />
                        <button
                          type="submit"
                          data-sign={g.key}
                          className="btn btn--ink btn--sm"
                        >
                          Sign {g.inline}
                        </button>
                      </form>
                    ))}
                  {!maySign && !state.signed && !state.unchanged && (
                    <span className="pill pill--quiet">
                      {g.key === "PRICE"
                        ? "Finance signs this"
                        : g.key === "RERA"
                          ? "Compliance signs this"
                          : "Brand signs this"}
                    </span>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </Cards>

      {!editing && !shown && !inheritsFrom.length && (
        <section className="card">
          <div className="empty" style={{ padding: "26px 20px" }}>
            Nothing has been set for {brain.node.name} yet.
          </div>
        </section>
      )}
    </>
  );
}

/**
 * The cards, wrapped in the draft form only while editing. A reviewer's sign
 * button is its own form, and forms cannot nest.
 *
 * A kept form: a refusal is said above the cards and every typed value stays
 * where it was, rather than a redirect putting back the last saved ones.
 */
function Cards({
  editing,
  nodeId,
  children,
}: {
  editing: boolean;
  nodeId: string;
  children: React.ReactNode;
}) {
  if (!editing) return <div className="braingroups">{children}</div>;
  return (
    <KeptForm id="braindraft" action={brainDraftAction}>
      <input type="hidden" name="nodeId" value={nodeId} />
      <div className="stack brainedit">{children}</div>
    </KeptForm>
  );
}

type Inherit = {
  /** The value a field of one value takes from above, or null. */
  value: string | null;
  from: string | null;
  /** The lines a list takes from above. */
  lines: { text: string; from: string }[];
};

function inheritedFor(inherited: InheritedBrain, def: FieldDef): Inherit {
  if (def.type === "LIST") return { value: null, from: null, lines: inherited.lines[def.key] ?? [] };
  const value = inherited.values[def.key] ?? null;
  return { value: value || null, from: value ? (inherited.from[def.key] ?? null) : null, lines: [] };
}

function GroupPill({ state }: { state: GroupState }) {
  if (state.signed) {
    return (
      <span className="pill pill--ok">
        <span className="pill__dot" />
        Signed
      </span>
    );
  }
  if (state.stale) {
    return (
      <span className="pill pill--risk">
        <span className="pill__dot" />
        Changed since signing
      </span>
    );
  }
  if (state.unchanged) return <span className="pill pill--quiet">No change</span>;
  return (
    <span className="pill pill--warn">
      <span className="pill__dot" />
      Needs signing
    </span>
  );
}

/** Whether this group is signed, and by whom. */
function Status({ state }: { state: GroupState }) {
  if (state.signature) {
    return (
      <span className="brainsign__who">
        <span className="qi__mark qi__mark--ok">
          <Check size={13} />
        </span>
        Signed by {state.signature.signedByName ?? "a colleague"} on{" "}
        {onDate(state.signature.signedAt)}
      </span>
    );
  }
  if (state.stale) {
    return (
      <span className="brainsign__who">
        <span className="qi__mark qi__mark--risk">
          <Alert size={13} />
        </span>
        Changed after it was signed.
      </span>
    );
  }
  if (state.unchanged) {
    return <span className="brainsign__who sub">Unchanged from the live version.</span>;
  }
  return <span className="brainsign__who sub">Not signed yet.</span>;
}

/**
 * One field in the editor. An empty field here takes the value from above, so
 * the box shows that value, and where it comes from, in place of an example;
 * a list shows the lines it already has from above, read-only, over the box
 * that adds to them.
 */
type Source = { documentId: string; name: string; page: number; href: string } | null;

/** "Price list, page 2": where a value was read from, linking to its document. */
function SourceHint({ source }: { source: Source }) {
  if (!source) return null;
  return (
    <a className="hint brainsource" href={`${source.href}#doc-${source.documentId}`} data-source="">
      {source.name}, page {source.page}
    </a>
  );
}

function Field({ def, value, inherited, source }: { def: FieldDef; value: string | null; inherited: Inherit; source: Source }) {
  const placeholder =
    def.type === "LIST"
      ? inherited.lines.length
        ? "One per line, added to the lines above"
        : def.placeholder
      : inherited.value
        ? `${showValue(def, inherited.value)}, from ${inherited.from}`
        : def.placeholder;
  const common = {
    id: def.key,
    name: def.key,
    defaultValue: value ?? "",
    placeholder,
  };
  return (
    <label className="formfield" htmlFor={def.key}>
      <span className="formfield__label">
        {def.label}
        {/* Answered from above is answered. */}
        {def.required && !inherited.value && <span className="formfield__req"> required</span>}
        <SourceHint source={source} />
      </span>
      {def.type === "LIST" ? (
        <div style={{ gridArea: "input", minWidth: 0 }}>
          {inherited.lines.length > 0 && <InheritedLines lines={inherited.lines} />}
          <textarea {...common} className="formfield__input" rows={4} spellCheck={false} />
        </div>
      ) : (
        <input
          {...common}
          type="text"
          inputMode={def.type === "MONEY" ? "numeric" : def.type === "PERCENT" ? "decimal" : undefined}
          className="formfield__input"
        />
      )}
    </label>
  );
}

function InheritedLines({ lines }: { lines: { text: string; from: string }[] }) {
  return (
    <ul className="brainlist" style={{ margin: "10px 0" }}>
      {lines.map((l, i) => (
        <li key={i}>
          {l.text} <span className="formfield__unset">· from {l.from}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One field as it reads. A value this node does not set, and a node above
 * does, is shown with where it comes from: it is what every advertisement for
 * this node carries, so "Not set" there was wrong.
 */
function ReadOnly({ def, value, inherited, source }: { def: FieldDef; value: string | null; inherited: Inherit; source: Source }) {
  if (def.type === "LIST") {
    const own = asList(value);
    const mine = new Set(own.map((x) => x.toLowerCase()));
    const above = inherited.lines.filter((l) => !mine.has(l.text.toLowerCase()));
    // Where the lines from above come from is said once, beside the label,
    // when they all come from one place; the lines themselves read softer.
    const places = [...new Set(above.map((l) => l.from))];
    const oneSource = places.length === 1 ? places[0] : null;
    return (
      <div className="formfield">
        <span className="formfield__label">
          {def.label}
          {oneSource && (
            <small className="hint">
              {own.length ? `${above.length} from ${oneSource}` : `from ${oneSource}`}
            </small>
          )}
        </span>
        <span className="formfield__value">
          {above.length + own.length ? (
            <ul className="brainlist">
              {above.map((l, i) => (
                <li key={`a${i}`} className={oneSource && own.length ? "brainlist__above" : undefined}>
                  {l.text}
                  {!oneSource && <span className="formfield__unset"> · from {l.from}</span>}
                </li>
              ))}
              {own.map((t, i) => (
                <li key={`o${i}`}>{t}</li>
              ))}
            </ul>
          ) : (
            <span className="formfield__unset">Not set</span>
          )}
        </span>
      </div>
    );
  }

  const fromAbove = !value && inherited.value ? inherited : null;
  const text = showValue(def, value || inherited.value);
  return (
    <div className="formfield">
      <span className="formfield__label">
        {def.label}
        {fromAbove && <small className="hint">from {fromAbove.from}</small>}
        {!fromAbove && <SourceHint source={source} />}
      </span>
      <span className="formfield__value">
        {text || <span className="formfield__unset">Not set</span>}
      </span>
    </div>
  );
}
