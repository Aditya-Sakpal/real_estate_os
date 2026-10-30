"use client";

import { addWordAction } from "@/app/actions/pronounce";
import { KeptForm } from "@/components/KeptForm";
import { useFormStatus } from "react-dom";

function Add() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--ink btn--sm" disabled={pending} data-add-word="">
      {pending ? "Adding" : "Add word"}
    </button>
  );
}

/** A word the list did not find: a landmark, a road, a name the agent should say well. */
export default function AddWord({ nodeId }: { nodeId: string }) {
  return (
    <KeptForm action={(form) => addWordAction(null, form)} clearOnSuccess messageAt="bottom" className="addword">
      <input type="hidden" name="nodeId" value={nodeId} />
      <div className="field">
        <label htmlFor="aw-word">Word</label>
        <input id="aw-word" name="written" type="text" required maxLength={60} placeholder="e.g. Hinjewadi Phase 3" autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="aw-said">How it is said</label>
        <input id="aw-said" name="said" type="text" maxLength={80} placeholder="Leave empty to hear it first" autoComplete="off" />
      </div>
      <Add />
    </KeptForm>
  );
}
