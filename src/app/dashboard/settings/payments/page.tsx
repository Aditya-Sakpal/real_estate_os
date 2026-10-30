import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { PageHead } from "@/components/shell/PageHead";
import { ConfirmAction } from "@/components/ConfirmAction";
import { readFlash } from "@/lib/flash";
import { paymentAccount, paymentsReady } from "@/lib/payments";
import { disconnectPaymentsAction } from "@/app/actions/leads";
import { ArrowUpRight, Wallet } from "@/components/icons";

/**
 * The developer's own Razorpay account, which a buyer's token is paid into.
 * Read-only: connected or not, and one action to change that.
 */
export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("integration:manage")) redirect("/dashboard/settings");
  const q = await searchParams;
  const [account] = await Promise.all([paymentAccount(viewer.state.org.id)]);
  const error = readFlash(q, "error");
  const done = readFlash(q, "done");
  const ready = paymentsReady();

  const connect = (label: string) =>
    ready ? (
      <a href="/api/payments/razorpay/start" className="btn btn--ink">
        {label}
        <ArrowUpRight size={14} />
      </a>
    ) : (
      <button type="button" className="btn btn--ink" disabled>
        {label}
      </button>
    );

  return (
    <>
      <PageHead
        back={{ label: "Settings", href: "/dashboard/settings" }}
        title={
          <>
            Token <span className="em">payments</span>
          </>
        }
        meta={account ? `Razorpay ${account.accountId}${account.mode === "test" ? ", test mode" : ""}` : "Not connected"}
        action={!account ? connect("Connect Razorpay") : account.status === "BROKEN" ? connect("Connect again") : null}
      />
      {error && (
        <p className="note note--risk" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </p>
      )}
      {done && (
        <p className="note" role="status" style={{ marginBottom: 14 }}>
          {done}
        </p>
      )}
      {account ? (
        <section className="card">
          <div className="card__head">
            <h2>Razorpay</h2>
            <span className={`pill ${account.status === "ACTIVE" ? "pill--ok" : "pill--risk"}`}>
              {account.status === "ACTIVE" ? "Connected" : "Stopped working"}
            </span>
            <ConfirmAction
              label="Disconnect"
              title="Disconnect Razorpay?"
              body="Token links already sent keep working. No new ones can be sent until an account is connected."
              confirmLabel="Disconnect"
              action={disconnectPaymentsAction}
              fields={{}}
              tone="risk"
            />
          </div>
          <div className="fieldgrid">
            <div className="formfield">
              <span className="formfield__label">Account</span>
              <span className="formfield__value tnum">{account.accountId}</span>
            </div>
            <div className="formfield">
              <span className="formfield__label">Mode</span>
              <span className="formfield__value">{account.mode === "test" ? "Test" : "Live"}</span>
            </div>
            <div className="formfield">
              <span className="formfield__label">Connected on</span>
              <span className="formfield__value tnum">
                {new Date(account.connectedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}
              </span>
            </div>
          </div>
        </section>
      ) : (
        <section className="card empty">
          <span className="empty__mark">
            <Wallet size={18} />
          </span>
          <h2 style={{ marginTop: 4, fontSize: 16, color: "var(--ink)" }}>No Razorpay account yet</h2>
          <p className="sub" style={{ marginTop: 4 }}>
            {ready ? "Connect the Razorpay account buyers pay their token into." : "Connecting Razorpay isn't set up yet."}
          </p>
        </section>
      )}
    </>
  );
}
