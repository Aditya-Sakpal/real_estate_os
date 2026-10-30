"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { importInvitesAction } from "@/app/actions/import";
import { planImport, exampleCsv, MAX_ROWS, type CsvRole } from "@/lib/csv-rules";
import { depthOf, nodesForRole, type ScopeNode } from "@/lib/scope-rules";
import { useKeptSubmit, type FormResult } from "@/components/KeptForm";
import { NBSP } from "./ScopedRole";
import { Person, Alert, Clock } from "@/components/icons";

/**
 * Bulk invite, with the verdict shown before anything is written.
 *
 * The preview runs `planImport` in the browser, the same function the server
 * runs when the form is submitted. That is deliberate: a preview computed by
 * different code from the one that decides is a preview that will eventually
 * lie. This copy is a convenience and has no authority; the server re-reads
 * the text and re-plans it against live tenant state, so a row can still be
 * refused after looking fine here.
 *
 * What it cannot know locally is who is already on the team, so those rows
 * read as ready here and come back as skipped. Saying "already on the team"
 * before the server has looked would be a guess.
 */

function Submit({ ready }: { ready: number }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--ink" type="submit" disabled={pending || ready === 0}>
      {pending
        ? "Inviting…"
        : ready === 0
          ? "Nothing to import"
          : `Invite ${ready} ${ready === 1 ? "person" : "people"}`}
    </button>
  );
}

export function ImportPeople({
  grantable,
  allRoles,
  nodes,
  defaultRoleKey,
  orgPrimaryDomain,
}: {
  grantable: CsvRole[];
  allRoles: CsvRole[];
  /** Where this inviter may land somebody. Filtered on the server too. */
  nodes: ScopeNode[];
  defaultRoleKey: string;
  orgPrimaryDomain: string | null;
}) {
  const [text, setText] = useState("");
  // No role is chosen for the rows that name none until somebody chooses
  // one. A preselected Sales Head made every such row a Sales Head for the
  // whole organisation without anybody deciding it.
  const [role, setRole] = useState(defaultRoleKey);
  const [wantedScope, setWantedScope] = useState("");
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, dispatch] = useActionState<FormResult, FormData>(importInvitesAction, null);
  const onSubmit = useKeptSubmit(dispatch);

  // The default place has to suit the default role, for the same reason the
  // single invite's two controls do: a pair that cannot exist would refuse
  // every row that named neither. With no role chosen, every place is open.
  const roleDef = grantable.find((r) => r.key === role);
  const places = useMemo(
    () => (roleDef ? nodesForRole(nodes, roleDef) : nodes),
    [nodes, roleDef],
  );
  const scopeId = places.some((n) => n.id === wantedScope)
    ? wantedScope
    : (places[0]?.id ?? "");

  const deepest = nodes.some((n) => n.kind !== "ORG");
  // Against the list shown, not the whole tree: a one-level list has nothing
  // to indent under.
  const shallowest = places.length ? Math.min(...places.map((n) => depthOf(n.path))) : 0;

  const plan = useMemo(
    () =>
      text.trim()
        ? planImport({
            text,
            grantable,
            allRoles,
            nodes,
            allNodes: nodes,
            defaultRoleKey: role,
            defaultScopeId: scopeId,
            orgPrimaryDomain,
          })
        : null,
    [text, role, scopeId, grantable, allRoles, nodes, orgPrimaryDomain],
  );

  // Distinct warnings with a count, rather than the same sentence on every
  // row it applies to.
  const warnings = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of plan?.rows ?? []) {
      if (r.verdict === "READY" && r.warning) {
        seen.set(r.warning, (seen.get(r.warning) ?? 0) + 1);
      }
    }
    return [...seen].map(([text, count]) => ({ text, count }));
  }, [plan]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
  }

  if (!open) {
    return (
      <div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
          Add several at once
        </button>
        <p className="sub" style={{ marginTop: 8, maxWidth: "62ch" }}>
          Paste a list or choose a spreadsheet.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="rolelist__sep" style={{ marginTop: 0 }}>
        From a list
      </div>

      <form action={dispatch} onSubmit={onSubmit}>
        {result && !result.ok && (
          <div className="note note--risk" style={{ marginBottom: 12 }} role="alert">
            {result.message}
          </div>
        )}
        <input type="hidden" name="csv" value={text} />
        <input type="hidden" name="defaultRole" value={role} />
        <input type="hidden" name="defaultScope" value={scopeId} />

        <div className="import__source">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={onFile}
            aria-label="Choose a CSV file"
            className="import__file"
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setText(exampleCsv(grantable, nodes))}
          >
            Show me the format
          </button>
        </div>

        <textarea
          className="import__text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={6}
          aria-label="The list of people"
          placeholder={"email,name,role\npriya@company.com,Priya Nair,Sales Head"}
        />

        <div className="import__controls">
          <label className="import__label" htmlFor="importDefaultRole">
            Rows with no role become
          </label>
          <select
            id="importDefaultRole"
            className="mini-select import__role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="" disabled>
              Choose
            </option>
            {grantable.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>

          {deepest && (
            <>
              <label className="import__label" htmlFor="importDefaultScope">
                and land at
              </label>
              <select
                id="importDefaultScope"
                className="mini-select import__role"
                value={scopeId}
                onChange={(e) => setWantedScope(e.target.value)}
              >
                {places.map((n) => (
                  <option key={n.id} value={n.id}>
                    {NBSP.repeat((depthOf(n.path) - shallowest) * 3) + n.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        {plan?.fatal && (
          <div className="note note--risk" style={{ marginTop: 14 }} role="alert">
            {plan.fatal}
          </div>
        )}

        {plan && !plan.fatal && (
          <>
            <div className="import__tally">
              <span className="pill pill--ok">
                <span className="pill__dot" />
                {plan.ready} to invite
              </span>
              {plan.skipped > 0 && (
                <span className="pill pill--quiet">{plan.skipped} already here</span>
              )}
              {plan.errored > 0 && (
                <span className="pill pill--risk">
                  <span className="pill__dot" />
                  {plan.errored} cannot be read
                </span>
              )}
            </div>

            {warnings.length > 0 && (
              <div className="note note--warn" style={{ marginTop: 12 }}>
                {warnings.map((w) => (
                  <p key={w.text} style={{ margin: "2px 0" }}>
                    {w.count > 1 ? `${w.count} addresses: ` : ""}
                    {w.text}
                  </p>
                ))}
              </div>
            )}

            <div className="import__rows">
              {plan.rows.map((r) => (
                <div key={`${r.line}-${r.email}`} className="invited">
                  <span
                    className={
                      r.verdict === "ERROR"
                        ? "qi__mark qi__mark--risk"
                        : r.verdict === "SKIP"
                          ? "qi__mark qi__mark--info"
                          : "qi__mark qi__mark--warn"
                    }
                  >
                    {r.verdict === "ERROR" ? (
                      <Alert size={13} />
                    ) : r.verdict === "SKIP" ? (
                      <Person size={13} />
                    ) : (
                      <Clock size={13} />
                    )}
                  </span>
                  <span className="invited__id">
                    <span className="invited__mail">{r.email || `Line ${r.line}`}</span>
                    <span className="invited__meta">
                      line {r.line}
                      {r.name ? ` · ${r.name}` : ""}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </span>
                  </span>
                  <span className="invited__role">
                    {r.roleLabel && <span className="pill pill--quiet">{r.roleLabel}</span>}
                    {r.scopeName && r.verdict !== "ERROR" && deepest && (
                      <span className="pill pill--quiet">{r.scopeName}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {plan && !plan.fatal && (
          <div className="import__go">
            <Submit ready={plan.ready} />
          </div>
        )}

        <p className="sub" style={{ marginTop: 12, maxWidth: "68ch" }}>
          One person per row: email, name, role{deepest ? " and place" : ""}. Up to {MAX_ROWS} rows.
        </p>
      </form>
    </div>
  );
}
