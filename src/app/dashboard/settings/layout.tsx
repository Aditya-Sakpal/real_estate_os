import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { SectionFrame } from "@/components/shell/SectionFrame";
import { settingsGroups, settingsNav } from "./items";
import "./settings.css";

/**
 * Settings are the developer's own: its companies, roles, accounts, plan and
 * sign-on. A firm working through a mandate never reaches them, whatever
 * key its people hold.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (viewer.via) redirect("/dashboard");
  return (
    <SectionFrame label="Settings" groups={settingsNav(settingsGroups(viewer))}>
      {children}
    </SectionFrame>
  );
}
