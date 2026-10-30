"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { saveOperatorNote } from "@/lib/admin-data";
import { requireOperator } from "@/lib/operator";

/** Saves the operator's note on a client, and whether it is a test company. */
export async function saveNoteAction(form: FormData): Promise<void> {
  const email = await requireOperator();
  const id = String(form.get("id") ?? "");
  const ok = await saveOperatorNote(id, form.get("test") === "on", String(form.get("note") ?? ""), email);
  revalidatePath("/", "layout");
  redirect(`/clients/${id}?tab=${String(form.get("tab") ?? "overview")}${ok ? "&saved=1" : ""}`);
}
