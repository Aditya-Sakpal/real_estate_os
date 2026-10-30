import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { listClients } from "@/lib/admin-data";
import { onAdminHost, SESSION_COOKIE, verify } from "@/lib/operator";

/** Every client as a spreadsheet, for an operator. */
export async function GET(req: NextRequest) {
  if (!(await onAdminHost())) return new NextResponse(null, { status: 404 });
  if (!verify((await cookies()).get(SESSION_COOKIE)?.value, "session")) return new NextResponse(null, { status: 401 });
  const tests = req.nextUrl.searchParams.get("tests") === "1";
  const rows = (await listClients()).filter((c) => tests || !c.isTest);
  // A cell starting = + - @ is made literal, so the file runs nothing when opened.
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = [
    "Client", "Kind", "Status", "Joined", "Plans", "Plan value a month (Rs)", "Paid so far (Rs)", "Projects", "Towers", "People",
    "Last active", "Leads this month", "Leads in all", "Booked in all", "AI calls this month", "Picked up", "Call minutes",
    "Visits this month", "Posts this month", "Videos this month", "Jimmy questions", "Our cost this month (Rs)", "Our cost last month (Rs)",
    "Our cost in all (Rs)", "Test company", "Our note",
  ];
  const lines = rows.map((c) =>
    [
      c.name, c.type, c.status, c.createdAt.toISOString().slice(0, 10), c.plans.map((p) => p.plan).join(" "),
      Math.round(c.planValuePaise / 100), Math.round(c.paidPaise / 100), c.projects, c.towers, c.members,
      c.lastActivity ? c.lastActivity.toISOString() : "", c.leadsMonth, c.leadsAll, c.bookedAll, c.callsMonth, c.connectedMonth,
      c.callMinutesMonth, c.visitsMonth, c.postsMonth, c.videosMonth, c.questionsMonth, Math.round(c.costMonthPaise / 100),
      Math.round(c.costLastMonthPaise / 100), Math.round(c.costAllPaise / 100), c.isTest ? "yes" : "", c.note ?? "",
    ]
      .map(cell)
      .join(","),
  );
  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse([head.join(","), ...lines].join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="salesdesk-clients-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
