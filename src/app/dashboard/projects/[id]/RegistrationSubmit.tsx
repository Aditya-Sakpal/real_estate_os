"use client";

import { useFormStatus } from "react-dom";
import { ArrowUpRight } from "@/components/icons";

/**
 * The registration form's button. Recording a Maharashtra number asks
 * MahaRERA first, which takes six to thirteen seconds, and a button that sat
 * there unchanged for that long read as a press that had not landed.
 */
export function RegistrationSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--ink" disabled={pending} aria-busy={pending}>
      {pending ? "Checking MahaRERA" : "Record as verified"}
      {!pending && <ArrowUpRight size={14} />}
    </button>
  );
}
