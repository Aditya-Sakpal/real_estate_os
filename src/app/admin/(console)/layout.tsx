import { Suspense } from "react";
import { NavProgress } from "@/components/shell/NavProgress";
import { problemCount } from "@/lib/admin-data";
import { requireOperator } from "@/lib/operator";
import { AdminRail } from "./AdminRail";

/** The operator console, in the client console's own shell. */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const email = await requireOperator();
  const problems = await problemCount().catch(() => 0);
  const initials = email.slice(0, 2).toUpperCase();
  const month = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date());

  return (
    <div className="shell adm-shell">
      <a href="#main" className="skip">
        Skip to the page
      </a>
      <Suspense fallback={null}>
        <NavProgress />
      </Suspense>
      <AdminRail problems={problems} />
      <header className="bar">
        <nav className="crumbs" aria-label="Where you are">
          <span className="crumb crumb--here">Sales Desk admin · {month}</span>
        </nav>
        <span />
        <div className="adm-bar-end">
          <span className="pill pill--quiet adm-bar-mode">Nothing charged yet: billing in shadow mode</span>
          <span className="adm-bar-who" title={email}>
            <span className="avatar" aria-hidden>
              {initials}
            </span>
            <span className="adm-bar-email">{email}</span>
          </span>
          <form action="/signout" method="post">
            <button type="submit" className="btn btn--light btn--sm">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="main" id="main" tabIndex={-1}>
        <div className="wrap">{children}</div>
      </main>
    </div>
  );
}
