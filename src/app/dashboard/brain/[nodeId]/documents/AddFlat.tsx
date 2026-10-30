"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { addFlatAction } from "@/app/actions/extract";
import type { FormResult } from "@/components/KeptForm";

function Go({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--sm btn--ghost" disabled={pending} data-add-flat="">
      {pending ? "Recording" : label}
    </button>
  );
}

/** Record a flat the price list names and the tower does not, unapproved. */
export default function AddFlat({
  nodeId,
  config,
  carpet,
  balcony,
  price,
  towerName,
}: {
  nodeId: string;
  config: string;
  carpet: number | null;
  balcony: number | null;
  price: number | null;
  towerName: string;
}) {
  const [state, action] = useActionState<FormResult, FormData>(addFlatAction, null);
  if (state?.ok) return <span className="pill pill--ok">Recorded</span>;
  return (
    <form action={action} className="flat__add">
      <input type="hidden" name="nodeId" value={nodeId} />
      <input type="hidden" name="config" value={config} />
      <input type="hidden" name="carpet" value={carpet ?? ""} />
      <input type="hidden" name="balcony" value={balcony ?? ""} />
      <input type="hidden" name="price" value={price ?? ""} />
      <Go label={`Record for ${towerName}`} />
      {state && !state.ok && (
        <span className="flat__err" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}
