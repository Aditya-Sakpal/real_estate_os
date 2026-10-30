import { redirect } from "next/navigation";

/** The workspace's old sections, and where each now lives in the console. */
const MOVED: Record<string, string> = {
  buyers: "/dashboard/developers/buyers",
  projects: "/dashboard/developers",
  payouts: "/dashboard/developers/payouts",
  team: "/dashboard/team",
  firm: "/dashboard/settings/firm",
};

export default async function OldWorkspace({ params }: { params: Promise<{ rest: string[] }> }) {
  const { rest } = await params;
  redirect(MOVED[rest[0] ?? ""] ?? "/dashboard");
}
