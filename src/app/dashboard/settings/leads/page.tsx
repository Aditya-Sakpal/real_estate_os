import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { PageHead } from "@/components/shell/PageHead";
import { loadLeadRules } from "@/lib/lead-settings";
import { LeadRules } from "./LeadRules";
import "./leads.css";

/**
 * How leads are sorted: when a returning buyer is a new lead, how a call is
 * scored into hot, warm and cold, the places and rival projects a call is
 * listened for, and who takes buyers calling from abroad. The banks a buyer
 * is introduced to are Home loans, Banks.
 */
export default async function LeadRulesPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("org:manage")) redirect("/dashboard/settings");
  const orgId = viewer.state.org.id;
  const rules = await loadLeadRules(orgId);

  return (
    <>
      <PageHead
        back={{ label: "Settings", href: "/dashboard/settings" }}
        title={
          <>
            Lead <span className="em">rules</span>
          </>
        }
        meta="How a returning buyer and a call's score are handled."
      />
      <LeadRules rules={rules} />
    </>
  );
}
