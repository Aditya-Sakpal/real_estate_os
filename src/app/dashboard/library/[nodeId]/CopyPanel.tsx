"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { copyAssetsAction, type CopyState } from "@/app/actions/asset";
import { useKeptSubmit } from "@/components/KeptForm";

/** Places something could be copied to, grouped under the project they sit in. */
export type TargetGroup = { project: string; options: { id: string; name: string }[] };

type Choosable = { id: string; title: string; category: string };

/**
 * Where a copy lands, chosen on purpose.
 *
 * It opens on "Choose where" and never on a real tower: the first option used
 * to be selected by default, so pressing Copy without looking filed the
 * pictures on whichever tower happened to sort first. Grouped by project,
 * because "Tower A" means nothing until you know whose.
 */
export function TargetSelect({
  groups,
  value,
  onChange,
}: {
  groups: TargetGroup[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select name="toNodeId" required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>
        Choose where
      </option>
      {groups.map((g) => (
        <optgroup key={g.project} label={g.project}>
          {g.options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * Copy what is filed here to another project or tower.
 *
 * The reason the library is a library: a clubhouse render shot once should
 * not be uploaded again for the next tower, and a floor plan that is genuinely
 * per tower should not be copyable to a project at all. The server refuses
 * the second case, and this only offers the nodes it could legally land on
 * and the person may add to.
 *
 * Approvals do not travel, and the button says so rather than leaving
 * somebody to discover it: a render approved for one project is not approved
 * for another project's clubhouse.
 *
 * A copy that landed clears the ticks and the place, so the next press cannot
 * send the same batch twice. A refusal clears nothing.
 */
export default function CopyPanel({
  nodeId,
  assets,
  targets,
}: {
  nodeId: string;
  assets: Choosable[];
  targets: TargetGroup[];
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [state, action] = useActionState<CopyState, FormData>(copyAssetsAction, null);
  const onSubmit = useKeptSubmit(action);

  useEffect(() => {
    if (!state?.ok) return;
    setChosen([]);
    setTarget("");
  }, [state]);

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  if (!assets.length || !targets.length) return null;

  return (
    <form action={action} onSubmit={onSubmit} className="copier">
      <input type="hidden" name="nodeId" value={nodeId} />

      <div className="copier__pick">
        {assets.map((a) => (
          <label key={a.id} className="checkset__item copier__item">
            <input
              type="checkbox"
              name="assetIds"
              value={a.id}
              checked={chosen.includes(a.id)}
              onChange={() => toggle(a.id)}
            />
            <span>
              <strong>{a.title}</strong>
              <small>{a.category}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="copier__go">
        <label className="uploader__field">
          <span>Copy to</span>
          <TargetSelect groups={targets} value={target} onChange={setTarget} />
        </label>
        <Submit count={chosen.length} ready={!!target} state={state} />
      </div>
    </form>
  );
}

function Submit({ count, ready, state }: { count: number; ready: boolean; state: CopyState }) {
  const { pending } = useFormStatus();
  return (
    <div className="copier__act">
      <button
        type="submit"
        className="btn btn--ink btn--sm"
        disabled={pending || count === 0 || !ready}
        data-copy
      >
        {pending
          ? "Copying"
          : count === 0
            ? "Choose what to copy"
            : !ready
              ? "Choose where"
              : `Copy ${count}`}
      </button>
      {state && (
        <span
          className={state.ok ? "uploader__said" : "uploader__said uploader__said--bad"}
          role={state.ok ? "status" : "alert"}
          data-copy-result
        >
          {state.message}
        </span>
      )}
    </div>
  );
}
