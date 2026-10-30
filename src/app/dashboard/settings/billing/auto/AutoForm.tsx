"use client";

import { useState } from "react";
import Link from "next/link";
import { rupees, type Sku } from "@/lib/billing-rules";
import { AUTO_MAX_QTY, chargeFor, thresholdShown, thresholdUnitWords, type AutoSetting } from "@/lib/auto-topup-rules";
import { saveAutoTopUpAction } from "@/app/actions/billing";

/**
 * The setting, opened by Change. What the threshold is counted in follows
 * the pack chosen, and the price of one top-up is shown with GST the way
 * the invoice will split it.
 */
export function AutoForm({ skus, setting, sellerState, buyerState }: { skus: Sku[]; setting: AutoSetting; sellerState: string; buyerState: string }) {
  const [skuKey, setSkuKey] = useState<string>(setting.sku ?? "");
  const [qty, setQty] = useState<string>(String(setting.qty || 1));
  const sku = skus.find((s) => s.key === skuKey);
  const n = Math.max(1, Math.min(AUTO_MAX_QTY, Math.floor(Number(qty) || 1)));
  const one = sku ? chargeFor(sku, sku.countable ? n : 1, sellerState, buyerState) : null;
  const shownThreshold = setting.threshold !== null && setting.sku ? thresholdShown(skus.find((s) => s.key === setting.sku)?.unit ?? "MINUTE", setting.threshold) : "";

  return (
    <form action={saveAutoTopUpAction} className="bill-form" data-auto-form>
      <label className="switch">
        <input type="checkbox" name="on" defaultChecked={setting.on} />
        <span>
          <span className="switch__name">Top up automatically</span>
        </span>
      </label>
      <div className="bill-form__row">
        <div className="field">
          <label htmlFor="auto-sku">Buy</label>
          <select id="auto-sku" name="sku" className="select-field" value={skuKey} onChange={(e) => setSkuKey(e.target.value)}>
            <option value="">Choose a top-up</option>
            {skus.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}, {rupees(s.pricePaise)}
              </option>
            ))}
          </select>
        </div>
        {sku?.countable ? (
          <div className="field">
            <label htmlFor="auto-qty">How many</label>
            <input id="auto-qty" name="qty" type="text" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="1" />
          </div>
        ) : (
          <input type="hidden" name="qty" value="1" />
        )}
      </div>
      <div className="bill-form__row">
        <div className="field">
          <label htmlFor="auto-threshold">When fewer than{sku ? `, in ${thresholdUnitWords(sku.unit)}` : ""}</label>
          <input id="auto-threshold" name="threshold" type="text" inputMode="numeric" defaultValue={shownThreshold} placeholder={sku?.unit === "WHATSAPP" ? "200" : sku?.unit === "MINUTE" ? "100" : "1"} />
        </div>
        <div className="field">
          <label htmlFor="auto-ceiling">Monthly limit, in rupees</label>
          <input id="auto-ceiling" name="ceiling" type="text" inputMode="numeric" defaultValue={setting.ceilingPaise ? String(setting.ceilingPaise / 100) : ""} placeholder="50000" />
        </div>
      </div>
      {one && (
        <p className="auto-one tnum" data-auto-one>
          One top-up: {rupees(one.totalPaise, true)} with GST
        </p>
      )}
      <div className="bill-form__actions">
        <button type="submit" className="btn btn--ink">
          Save auto top-up
        </button>
        <Link href="/dashboard/settings/billing/auto" className="btn btn--ghost">
          Cancel
        </Link>
      </div>
    </form>
  );
}
