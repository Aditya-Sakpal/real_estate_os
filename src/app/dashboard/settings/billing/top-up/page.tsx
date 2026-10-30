import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { topUpContext } from "@/lib/billing-pay";
import { SKUS, rupees } from "@/lib/billing-rules";
import { PageHead } from "@/components/shell/PageHead";
import { BillingTabs } from "../BillingTabs";
import { TopUpForm } from "./TopUpForm";
import "../billing.css";

/**
 * Buying prepaid top-ups. Priced here exactly as the server prices the
 * order, GST included, and paid through Razorpay's Checkout.
 *
 * Closed, it says so and shows the price list without a single control on
 * it: a basket that cannot be paid for is a control that does nothing.
 */
export default async function TopUpPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("billing:manage")) redirect("/dashboard/settings/billing");
  const ctx = await topUpContext(viewer.state.org.id);

  return (
    <>
      <PageHead
        title={
          <>
            Top <span className="em">up</span>
          </>
        }
        meta={ctx.open ? "Prepaid, used once a month's allowance runs out, and good for twelve months" : "Not open here yet"}
        back={{ label: "Plan and usage", href: "/dashboard/settings/billing" }}
      />
      <BillingTabs current="top-up" canManage />

      {!ctx.open ? (
        <section className="card" data-topup-closed>
          <div className="card__head">
            <h2>Top-ups are added by us for now</h2>
          </div>
          <p className="sub" style={{ marginBottom: 14 }}>
            Ask your Sales Desk contact and we add them to your account. These are the prices.
          </p>
          <ul className="bill-prices">
            {SKUS.filter((s) => !s.scaleOnly || ctx.hasScale).map((s) => (
              <li key={s.key}>
                <span>{s.label}</span>
                <span className="tnum">{rupees(s.pricePaise)}</span>
              </li>
            ))}
          </ul>
          <p className="bill-prices__foot">Before GST at 18%.</p>
        </section>
      ) : !ctx.buyerState ? (
        <section className="card" data-topup-needs-state>
          <div className="card__head">
            <h2>Where are you billed?</h2>
          </div>
          <p className="sub" style={{ marginBottom: 14 }}>
            The state on your invoice decides the GST, so add it before buying.
          </p>
          <Link href="/dashboard/settings/billing?edit=details#details" className="btn btn--ink">
            Add billing details
          </Link>
        </section>
      ) : (
        <TopUpForm
          skus={SKUS.filter((s) => !s.scaleOnly || ctx.hasScale)}
          test={ctx.test}
          interState={ctx.buyerState !== ctx.sellerState}
        />
      )}
    </>
  );
}
