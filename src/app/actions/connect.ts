"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { checkConnection, chooseAccounts, disconnect, setDailyCap, type Pick } from "@/lib/connect";
import { isProvider, providerSlug, type Provider } from "@/lib/connect-rules";
import { pauseEverySpending } from "@/lib/publish";
import { setQualifiedBidding } from "@/lib/bidding";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/**
 * Connected accounts.
 *
 * `integration:manage` for everything that touches a connection, because a
 * connection holds a token that spends money and speaks for the brand. The
 * daily limit on an ad account is `campaign.budget:manage` instead: deciding
 * how much of the developer's money an ad may move is a different power from
 * connecting the account it moves through.
 */

/**
 * Back to a screen with what happened. `error` and `done` are signed
 * messages; `disconnected` is a provider key the page reads back against its
 * own list.
 */
function back(provider: Provider | null, said?: { error?: string; done?: string; disconnected?: Provider }): never {
  const path = provider ? `/dashboard/settings/connections/${providerSlug(provider)}` : "/dashboard/settings/connections";
  const parts: string[] = [];
  if (said?.error) parts.push(flash("error", said.error));
  if (said?.done) parts.push(flash("done", said.done));
  if (said?.disconnected) parts.push(`disconnected=${said.disconnected}`);
  redirect(parts.length ? `${path}?${parts.join("&")}` : path);
}

function readProvider(formData: FormData): Provider | null {
  const raw = String(formData.get("provider") ?? "").toUpperCase();
  return isProvider(raw) ? raw : null;
}

/**
 * Choose the accounts posts go to. A refusal comes back to the form, so the
 * ticks and places somebody set survive it; a save goes back to the
 * read-only view.
 */
export async function chooseAccountsAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const provider = readProvider(formData);
  if (!provider) return { ok: false, message: "Choose Meta or Google." };

  // One checkbox per account, "KIND|id", and a place beside each.
  const picks: Pick[] = formData.getAll("pick").map((raw) => {
    const [kind, ...rest] = String(raw).split("|");
    const id = rest.join("|");
    return { kind, id, nodeId: String(formData.get(`node:${kind}|${id}`) ?? "") };
  });
  const result = await chooseAccounts({ orgId, userId, provider, picks });
  revalidatePath("/dashboard/settings/connections");
  if (!result.ok) return { ok: false, message: result.message };
  back(provider, { done: "Saved. Posts go to the accounts shown." });
}

export async function disconnectAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const provider = readProvider(formData);
  if (!provider) back(null, { error: "Choose Meta or Google." });
  // Spend first: once the token is gone nothing here can pause an ad again.
  const spending = await pauseEverySpending({ orgId, userId, provider: provider! });
  if (spending.failed > 0) {
    back(provider, {
      error: `${spending.failed} ${spending.failed === 1 ? "ad" : "ads"} could not be paused, so nothing was disconnected. Pause ${spending.failed === 1 ? "it" : "them"} from Published, then try again.`,
    });
  }
  await disconnect({ orgId, userId, provider: provider! });
  revalidatePath("/dashboard/settings/connections");
  back(null, { disconnected: provider! });
}

export async function checkConnectionAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const provider = readProvider(formData);
  if (!provider) back(null, { error: "Choose Meta or Google." });
  const result = await checkConnection({ orgId, provider: provider!, userId });
  revalidatePath("/dashboard/settings/connections");
  if (!result.ok) back(provider, { error: result.message });
  back(provider, { done: "Checked. It is working." });
}

/** One ad account's daily limit. A refusal keeps the amount typed. */
/**
 * Bid on qualified buyers for one Meta ad account, or go back to clicks.
 * The budget key, like the daily limit: it decides what the developer's
 * money is spent looking for.
 */
export async function setQualifiedBiddingAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("campaign.budget:manage");
  const result = await setQualifiedBidding({
    orgId,
    userId,
    accountId: String(formData.get("accountId") ?? ""),
    on: formData.get("on") === "true",
  });
  revalidatePath("/dashboard/settings/connections", "layout");
  back("META", result.ok ? { done: result.message } : { error: result.message });
}

export async function setDailyCapAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("campaign.budget:manage");
  const provider = readProvider(formData);
  const result = await setDailyCap({
    orgId,
    userId,
    accountId: String(formData.get("accountId") ?? ""),
    raw: String(formData.get("dailyCap") ?? ""),
  });
  revalidatePath("/dashboard/settings/connections");
  if (!result.ok) return { ok: false, message: result.message };
  back(provider, { done: "Daily limit saved." });
}
