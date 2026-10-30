"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { copyUnitTypesAction, type UnitCopyState } from "@/app/actions/unit";
import { useKeptSubmit } from "@/components/KeptForm";
import { TargetSelect, type TargetGroup } from "./CopyPanel";

type Choosable = { id: string; label: string; detail: string; assets: number };

/**
 * Copy configurations, and their pictures, to another tower.
 *
 * The ordinary case: Tower B sells the same 1 BHK and 2 BHK at the same
 * prices off the same plans, and nobody should be retyping any of it.
 *
 * Only towers are offered, because a configuration belongs to one of them,
 * and only towers the person may record on. The place starts unchosen, for
 * the reason `TargetSelect` gives. The pictures come across as a choice
 * rather than always, since a tower with its own photography wants the
 * numbers and not the images, and the choice is only offered to somebody
 * who may add pictures at all.
 *
 * Approvals do not travel, and the button says so rather than leaving it to
 * be discovered: a price approved for Tower A is a person saying it is right
 * for Tower A.
 */
export default function UnitCopyPanel({
  nodeId,
  units,
  targets,
  mayBringPictures,
}: {
  nodeId: string;
  units: Choosable[];
  targets: TargetGroup[];
  mayBringPictures: boolean;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [state, action] = useActionState<UnitCopyState, FormData>(copyUnitTypesAction, null);
  const onSubmit = useKeptSubmit(action);

  useEffect(() => {
    if (!state?.ok) return;
    setChosen([]);
    setTarget("");
  }, [state]);

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  if (!units.length || !targets.length) return null;

  const pictures = units
    .filter((u) => chosen.includes(u.id))
    .reduce((n, u) => n + u.assets, 0);

  return (
    <form action={action} onSubmit={onSubmit} className="copier">
      <input type="hidden" name="nodeId" value={nodeId} />

      <div className="copier__pick">
        {units.map((u) => (
          <label key={u.id} className="checkset__item copier__item">
            <input
              type="checkbox"
              name="unitTypeIds"
              value={u.id}
              checked={chosen.includes(u.id)}
              onChange={() => toggle(u.id)}
            />
            <span>
              <strong>{u.label}</strong>
              <small>{u.detail}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="copier__go">
        <label className="uploader__field">
          <span>Copy to</span>
          <TargetSelect groups={targets} value={target} onChange={setTarget} />
        </label>

        {mayBringPictures && pictures > 0 && (
          <label className="checkset__item copier__item">
            <input type="checkbox" name="withAssets" defaultChecked />
            <span>
              <strong>Bring the pictures</strong>
              <small>
                {pictures === 1 ? "1 picture" : `${pictures} pictures`} filed under these
              </small>
            </span>
          </label>
        )}

        <Submit count={chosen.length} ready={!!target} state={state} />
      </div>
    </form>
  );
}

function Submit({ count, ready, state }: { count: number; ready: boolean; state: UnitCopyState }) {
  const { pending } = useFormStatus();
  return (
    <div className="copier__act">
      <button
        type="submit"
        className="btn btn--ink btn--sm"
        disabled={pending || count === 0 || !ready}
        data-copy-units
      >
        {pending
          ? "Copying"
          : count === 0
            ? "Choose what to copy"
            : !ready
              ? "Choose a tower"
              : `Copy ${count}`}
      </button>
      {state && (
        <span
          className={state.ok ? "uploader__said" : "uploader__said uploader__said--bad"}
          role={state.ok ? "status" : "alert"}
          data-unit-copy-result
        >
          {state.message}
        </span>
      )}
    </div>
  );
}
