import { redirect } from "next/navigation";

/**
 * Every company works in the console now, a channel partner included
 * (30 September 2026). An old link to the workspace lands on Today.
 */
export default function Workspace() {
  redirect("/dashboard");
}
