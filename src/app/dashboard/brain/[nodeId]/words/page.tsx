import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { brainNode } from "@/lib/brain";
import { inReach } from "@/lib/grant-rules";
import { wordsAt } from "@/lib/pronounce";
import { heardWord, isDue, SAYING_CAPS, STATE_ORDER, wordState } from "@/lib/pronounce-rules";
import { ArrowLeft } from "@/components/icons";
import CheckWords from "./CheckWords";
import WordRow, { type WordView } from "./WordRow";
import AddWord from "./AddWord";
import "./words.css";

// A check says and hears up to forty words, four at a time.
export const maxDuration = 300;

/**
 * How the calling agent says a project's or tower's words: its names and the
 * places its facts name. Each can be heard in the call voice, is marked by
 * whether it came back as meant, and can be written the way it is really
 * said. Every call about the place carries those spellings.
 */
export default async function WordsPage({ params }: { params: Promise<{ nodeId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("brain:read")) redirect("/dashboard");
  const { nodeId } = await params;
  const orgId = viewer.state.org.id;
  const node = await brainNode(orgId, nodeId);
  if (!node || (node.kind !== "PROJECT" && node.kind !== "PHASE") || !inReach(node.path, viewer.authz.scopesFor("brain:read"))) notFound();
  const found = await wordsAt(orgId, node.id);
  if (!found) notFound();

  const { place } = found;
  const mayEdit = viewer.authz.canAt("brain:edit", place.path);
  const words: WordView[] = found.words
    .map((w, i) => ({ w, i, state: wordState(w) }))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.i - b.i)
    .map(({ w, state }) => ({
      written: w.written,
      state,
      said: w.said ?? w.regionSaid,
      ownSaid: w.said && !w.saidAt ? w.said : null,
      saidAt: w.said ? w.saidAt : null,
      heard: heardWord(w.heard),
      sampled: w.sampled,
    }));
  const due = found.words.filter(isDue).length;
  const count = (s: string) => words.filter((w) => w.state === s).length;

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href={`/dashboard/brain/${place.id}`} className="backlink">
            <ArrowLeft size={14} />
            Back to the Brain
          </Link>
          <h1 style={{ marginTop: 4 }}>
            How the agent <span className="em">says</span> it
          </h1>
          <p className="sub" style={{ marginTop: 6 }}>
            {place.label} · {words.length} {words.length === 1 ? "word" : "words"}
          </p>
        </div>
      </div>

      <div className="words">
        <section className="card words__list" aria-labelledby="w-h">
          <div className="card__head">
            <h2 id="w-h">Words on calls</h2>
          </div>
          {words.length ? (
            <ul className="wordrows">
              {words.map((w) => (
                <WordRow key={w.written} w={w} nodeId={place.id} mayEdit={mayEdit} />
              ))}
            </ul>
          ) : (
            <div className="empty words__empty">No names or places to check yet.</div>
          )}
        </section>

        <div className="words__side">
          <Status
            wrong={count("WRONG")}
            failed={count("FAILED")}
            unchecked={count("UNCHECKED")}
            total={words.length}
            mayEdit={mayEdit}
            check={mayEdit && due > 0 ? <CheckWords nodeId={place.id} count={Math.min(due, SAYING_CAPS.perCheck)} /> : null}
          />
          {mayEdit && (
            <section className="card" aria-labelledby="aw-h">
              <div className="card__head">
                <h2 id="aw-h">Add a word</h2>
              </div>
              <AddWord nodeId={place.id} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The group's one near-black card: what is left before calls say every word
 * well, and the page's one primary action when there is something to check.
 */
function Status(o: { wrong: number; failed: number; unchecked: number; total: number; mayEdit: boolean; check: React.ReactNode }) {
  const n = (k: number) => `${k} ${k === 1 ? "word" : "words"}`;
  const [title, body] = o.wrong
    ? [`${n(o.wrong)} may sound wrong`, `${o.wrong === 1 ? "Play it" : "Play each one"}${o.mayEdit ? ". If it sounds off, write how it is said." : " to hear it."}`]
    : o.failed
      ? [`${n(o.failed)} could not be checked`, o.check ? null : "Check again in a few minutes."]
      : o.unchecked
        ? [`${n(o.unchecked)} not checked yet`, o.check ? null : "Nobody has checked these yet."]
        : o.total
          ? ["No word came back wrong", "Play the project's own name once to be sure."]
          : ["No words to check yet", o.mayEdit ? "Add a word the agent should say well." : null];
  return (
    <section className="card words__status" aria-live="polite">
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {o.check}
    </section>
  );
}
