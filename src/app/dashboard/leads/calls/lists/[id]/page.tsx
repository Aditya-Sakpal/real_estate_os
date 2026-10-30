import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { getCallList } from "@/lib/call-lists";
import { LIST_SOURCES, LIST_SOURCE_LABEL, LIST_STATE_LABEL, MEANING_LABEL, ROW_STATE_LABEL, openQuestions, type ListRowState } from "@/lib/call-list-rules";
import { answerListQuestionsAction, deleteCallListAction, saveListGoalAction, saveListSourceAction, setListStateAction, startCallListAction, stopCallListAction } from "@/app/actions/call-lists";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { LiveRefresh, PendingButton, QuestionFields, SourcePicker, StartFields } from "../ListControls";
import "../../../availability/availability.css";
import "../lists.css";

const ROW_TONE: Record<ListRowState, string> = { READY: "quiet", CALLING: "blue", CALLED: "ok", UNREACHED: "warn", REFUSED: "risk", SKIPPED: "quiet" };
const LIST_TONE = { DRAFT: "warn", RUNNING: "blue", PAUSED: "warn", DONE: "ok", CANCELLED: "quiet" } as const;
const LANG = { hi: "Hindi", mr: "Marathi", en: "English" } as const;

/**
 * One call list: what the sheet was read as, what each person's call will
 * do, and the one control that matters now (start, pause, carry on).
 */
export default async function CallListPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:read")) redirect("/dashboard");
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const list = await getCallList(viewer.state.org.id, id, viewer.authz.scopesFor("lead:read"));
  if (!list) notFound();
  const mayCall = viewer.authz.can("lead:call") && viewer.authz.can("lead:create");
  const total = list.rows.length;
  const ready = list.counts.READY;
  const towers = new Set(list.rows.map((r) => r.tower)).size;
  const used = list.columns.filter((c) => c.meaning !== "ignore");
  const now = Date.now();
  const open = list.state === "DRAFT" ? openQuestions(list.questions) : [];
  const answered = list.questions.filter((q) => q.answer || q.skipped);
  const about = (column: string | null | undefined) => (column ? `About the ${column} column` : "About the sheet");
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  const control =
    !mayCall ? null : list.state === "RUNNING" ? (
      <>
        <KeptForm action={setListStateAction}>
          <input type="hidden" name="listId" value={list.id} />
          <input type="hidden" name="to" value="PAUSED" />
          <PendingButton className="btn btn--ghost" pendingLabel="Pausing">
            Pause
          </PendingButton>
        </KeptForm>
        <StopButton listId={list.id} left={ready} />
      </>
    ) : list.state === "PAUSED" ? (
      <>
        <KeptForm action={setListStateAction}>
          <input type="hidden" name="to" value="RUNNING" />
          <input type="hidden" name="listId" value={list.id} />
          <PendingButton pendingLabel="Starting">Carry on calling</PendingButton>
        </KeptForm>
        <StopButton listId={list.id} left={ready} />
      </>
    ) : null;
  const remove =
    mayCall && list.state !== "RUNNING" ? (
      <ConfirmAction
        label="Delete list"
        title="Delete this list?"
        body="The list and its plan go. Leads and calls it already made stay on the board."
        confirmLabel="Delete list"
        action={deleteCallListAction}
        fields={{ listId: list.id }}
        tone="ghost"
        size="md"
      />
    ) : null;

  return (
    <>
      {list.state === "RUNNING" && <LiveRefresh />}
      <PageHead
        title={list.fileName}
        meta={
          <>
            <span className={`pill pill--${LIST_TONE[list.state]}`} style={{ marginRight: 8 }}>
              <span className="pill__dot" />
              {LIST_STATE_LABEL[list.state]}
            </span>
            {list.towers.length > 1 ? `${list.towers.length} towers` : list.tower.name} · {total.toLocaleString("en-IN")} {total === 1 ? "person" : "people"}
          </>
        }
        back={{ label: "Call lists", href: "/dashboard/leads/calls/lists" }}
        action={control || remove ? <div className="cls-controls">{control}{list.state !== "PAUSED" && remove}</div> : undefined}
      />

      <Flash text={readFlash(q, "done")} name="done" tone="info" />
      <Flash text={readFlash(q, "error")} name="error" />
      {list.state === "PAUSED" && list.pausedReason && <p className="note note--risk">Paused: {list.pausedReason}</p>}

      {list.state === "DRAFT" && mayCall && open.length > 0 && (
        <KeptForm action={answerListQuestionsAction} className="card cls-go">
          <input type="hidden" name="listId" value={list.id} />
          <QuestionFields questions={open.map((q) => ({ id: q.id, text: q.text, options: q.options, about: about(q.column) }))} />
        </KeptForm>
      )}

      {list.state === "DRAFT" && mayCall && open.length === 0 && (
        <KeptForm action={startCallListAction} className="card card--ink cls-go">
          <input type="hidden" name="listId" value={list.id} />
          {ready > 0 ? (
            <StartFields people={ready} developer={viewer.state.org.displayName} />
          ) : (
            <p className="cls-go__none">Nobody on this list can be called. See why beside each person.</p>
          )}
        </KeptForm>
      )}

      <div className="cls-grid">
        <section className="card" aria-labelledby="cls-read-h">
          <div className="card__head">
            <h2 id="cls-read-h">What the list says</h2>
          </div>
          {list.purpose && <p className="cls-purpose">{list.purpose}</p>}
          {list.state === "DRAFT" && mayCall ? (
            <KeptForm action={saveListSourceAction} className="cls-src-form">
              <input type="hidden" name="listId" value={list.id} />
              <SourcePicker initial={list.source} options={LIST_SOURCES.map((v) => ({ value: v, ...LIST_SOURCE_LABEL[v] }))} />
              <PendingButton className="btn btn--ghost" pendingLabel="Saving">
                Save
              </PendingButton>
            </KeptForm>
          ) : (
            <p className="cls-src-line">
              <span className="pill pill--quiet">{LIST_SOURCE_LABEL[list.source].label}</span> {LIST_SOURCE_LABEL[list.source].hint}
            </p>
          )}
          {list.towers.length > 1 && (
            <p className="cls-towers">
              Offers{" "}
              {list.towers.map((t, i) => (
                <span key={t.id} className={`pill ${i === 0 ? "pill--blue" : "pill--quiet"}`}>
                  {t.label}
                  {i === 0 ? " (default)" : ""}
                </span>
              ))}
            </p>
          )}
          <ul className="cls-cols" aria-label="Columns used">
            {used.map((c) => (
              <li key={c.index}>
                <span className="cls-cols__from">{c.header}</span>
                <span className="pill pill--quiet">{MEANING_LABEL[c.meaning]}</span>
              </li>
            ))}
          </ul>
          {used.some((c) => c.use) && (
            <dl className="cls-answers cls-uses">
              {used
                .filter((c) => c.use)
                .map((c) => (
                  <div key={c.index}>
                    <dt>{c.header}</dt>
                    <dd>{c.use}</dd>
                  </div>
                ))}
            </dl>
          )}
          {list.readBy === "rules" && <p className="av-import__hint">Read from the column names only.</p>}
          {answered.length > 0 && (
            <dl className="cls-answers">
              {answered.map((q) => (
                <div key={q.id}>
                  <dt>{q.text}</dt>
                  <dd>
                    {q.answer ?? "Left to the system"}
                    <span className="cls-note">{about(q.column)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="card" aria-labelledby="cls-goal-h">
          <div className="card__head">
            <h2 id="cls-goal-h">What most calls do</h2>
          </div>
          {list.state === "DRAFT" && mayCall ? (
            <KeptForm action={saveListGoalAction} className="cls-goal">
              <input type="hidden" name="listId" value={list.id} />
              <textarea name="goal" rows={3} maxLength={240} className="cls-goal__input" defaultValue={list.goal ?? ""} placeholder="Invite them for a site visit this weekend" aria-label="What most calls do" />
              <PendingButton className="btn btn--ghost" pendingLabel="Saving">
                Save
              </PendingButton>
            </KeptForm>
          ) : (
            <p className="cls-purpose">{list.goal ?? "A first conversation about the project."}</p>
          )}
          <p className="av-import__hint">A person whose row says something more gets their own, shown beside them.</p>
        </section>
      </div>

      <section className="card" aria-labelledby="cls-people-h">
        <div className="card__head">
          <h2 id="cls-people-h">People</h2>
          <div className="cls-counts">
            {(["READY", "CALLING", "CALLED", "UNREACHED", "REFUSED", "SKIPPED"] as ListRowState[])
              .filter((s) => list.counts[s] > 0)
              .map((s) => (
                <span key={s} className={`pill pill--${ROW_TONE[s]}`}>
                  {ROW_STATE_LABEL[s]} {list.counts[s].toLocaleString("en-IN")}
                </span>
              ))}
          </div>
        </div>
        <div className="av-scroll">
          <table className="av-table cls-table">
            <thead>
              <tr>
                <th scope="col" className="av-num">Line</th>
                <th scope="col">Name</th>
                <th scope="col">Phone</th>
                {towers > 1 && <th scope="col">Tower</th>}
                <th scope="col">Language</th>
                <th scope="col">The call</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {list.rows.map((r) => (
                <tr key={r.line}>
                  <td className="av-num av-faint">{r.line}</td>
                  <th scope="row">{r.leadId ? <Link href={`/dashboard/leads/${r.leadId}`} className="cls-link">{r.name}</Link> : r.name ?? <span className="av-faint">No name</span>}</th>
                  <td>{r.phone ?? <span className="av-faint">None</span>}</td>
                  {towers > 1 && <td>{r.tower}</td>}
                  <td>{LANG[r.language]}</td>
                  <td className="cls-wrap">
                    {open.length > 0 && r.note ? (
                      <span className="av-faint">Planned once you answer the questions</span>
                    ) : r.state === "SKIPPED" ? null : (
                      r.goal ?? <span className="av-faint">{list.goal ? "As the list" : "First conversation"}</span>
                    )}
                    {r.note && <span className="cls-note">{r.note}</span>}
                  </td>
                  <td className="cls-wrap">
                    <span className={`pill pill--${ROW_TONE[r.state]}`}>{ROW_STATE_LABEL[r.state]}</span>
                    {r.reason && <span className="cls-note">{r.reason}</span>}
                    {r.state === "READY" && r.notBefore && Date.parse(r.notBefore) > now && <span className="cls-note">From {whenLabel(r.notBefore, today)}</span>}
                    {r.window && (r.state === "READY" || r.state === "CALLING") && <span className="cls-note">Rung {hourLabel(r.window.from)} to {hourLabel(r.window.to)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** "15:00" as "3:00 pm". */
function hourLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "6:00 pm" today, "Mon 26 Oct, 10:00 am" on another day, India time. */
function whenLabel(iso: string, today: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  if (d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === today) return time;
  return `${d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

function StopButton({ listId, left }: { listId: string; left: number }) {
  return (
    <ConfirmAction
      label="Stop list"
      title="Stop this list?"
      body={`Nobody else on it is called${left ? `: ${left.toLocaleString("en-IN")} ${left === 1 ? "person is" : "people are"} left` : ""}. Calls already ringing finish.`}
      confirmLabel="Stop list"
      action={stopCallListAction}
      fields={{ listId }}
      tone="ghost"
      size="md"
    />
  );
}
