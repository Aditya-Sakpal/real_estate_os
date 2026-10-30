import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { deleteCallListAction, readCallListAction } from "@/app/actions/call-lists";
import { callableTowers, listCallLists } from "@/lib/call-lists";
import { LIST_SOURCES, LIST_SOURCE_LABEL, LIST_STATE_LABEL, MAX_LIST_ROWS } from "@/lib/call-list-rules";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { PendingButton, SourcePicker } from "./ListControls";
import { TowerPicker, type TowerGroup } from "./TowerPicker";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import "../../availability/availability.css";
import "./lists.css";

export const maxDuration = 300;

const TONE = { DRAFT: "warn", RUNNING: "blue", PAUSED: "warn", DONE: "ok", CANCELLED: "quiet" } as const;

/**
 * A spreadsheet of people for the agent to ring: upload it, then read the
 * plan on the next screen before anything is called.
 */
export default async function CallListsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:call") || !viewer.authz.can("lead:create")) redirect("/dashboard/leads/calls");
  const orgId = viewer.state.org.id;
  const [towers, lists, q] = await Promise.all([
    callableTowers(orgId, viewer.authz),
    listCallLists(orgId, viewer.authz.scopesFor("lead:read")),
    searchParams,
  ]);
  // Towers grouped under their projects, for the picker.
  const groups: TowerGroup[] = [];
  for (const t of towers) {
    const name = t.project ?? t.name;
    const g = groups.find((x) => x.project === name) ?? (groups.push({ project: name, towers: [] }), groups[groups.length - 1]);
    g.towers.push({ id: t.id, name: t.name, ok: t.ok });
  }

  return (
    <>
      <PageHead
        title={
          <>
            Call <span className="em">lists</span>
          </>
        }
        meta="Upload a sheet of people. The agent rings each one with what their row says."
        back={{ label: "Calls", href: "/dashboard/leads/calls" }}
      />

      <Flash text={readFlash(q, "done")} name="done" tone="info" />

      {towers.length === 0 ? (
        <section className="card av-none">
          <p>You can&rsquo;t call on any tower yet.</p>
        </section>
      ) : (
        <KeptForm action={readCallListAction} className="card av-import av-import--first">
          <div className="av-import__row">
            <div className="av-import__text">
              <label className="av-import__label" htmlFor="cls-sheet">
                Upload a list
              </label>
              <p className="av-import__hint">Excel or CSV, up to {MAX_LIST_ROWS} people. Any column names.</p>
            </div>
            <TowerPicker groups={groups} />
            <input
              id="cls-sheet"
              className="av-import__pick"
              type="file"
              name="sheet"
              required
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            />
          </div>
          <div className="cls-src-go">
            <SourcePicker options={LIST_SOURCES.map((v) => ({ value: v, ...LIST_SOURCE_LABEL[v] }))} />
            <PendingButton pendingLabel="Reading the list">
              Read the list
            </PendingButton>
          </div>
        </KeptForm>
      )}

      {lists.length > 0 && (
        <section className="card cls-recent" aria-labelledby="cls-recent-h">
          <div className="card__head">
            <h2 id="cls-recent-h" className="card__title">
              Your lists
            </h2>
          </div>
          <div className="av-scroll">
            <table className="av-table">
              <thead>
                <tr>
                  <th scope="col">List</th>
                  <th scope="col">Towers</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="av-num">People</th>
                  <th scope="col" className="av-num">Spoke</th>
                  <th scope="col" className="av-num">Left to call</th>
                  <th scope="col">
                    <span className="sr-only">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody className="tnum">
                {lists.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">
                      <Link href={`/dashboard/leads/calls/lists/${l.id}`} className="cls-link">
                        {l.fileName}
                      </Link>
                    </th>
                    <td>{l.tower}</td>
                    <td>
                      <span className={`pill pill--${TONE[l.state]}`}>{LIST_STATE_LABEL[l.state]}</span>
                    </td>
                    <td className="av-num">{Object.values(l.counts).reduce((a, b) => a + b, 0).toLocaleString("en-IN")}</td>
                    <td className="av-num">{l.counts.CALLED.toLocaleString("en-IN")}</td>
                    <td className="av-num">{(l.counts.READY + l.counts.CALLING).toLocaleString("en-IN")}</td>
                    <td className="cls-del">
                      {l.state !== "RUNNING" && (
                        <ConfirmAction
                          label="Delete"
                          title={`Delete ${l.fileName}?`}
                          body="The list and its plan go. Leads and calls it already made stay on the board."
                          confirmLabel="Delete list"
                          action={deleteCallListAction}
                          fields={{ listId: l.id }}
                          tone="ghost"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
