import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { onAdminHost } from "@/lib/operator";
import "./admin.css";

export const metadata: Metadata = {
  title: "Sales Desk admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Served only on admin.salesdesk.app (admin.localhost in development). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await onAdminHost())) notFound();
  return <div className="adm">{children}</div>;
}
