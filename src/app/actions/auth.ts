"use server";

import { cookies } from "next/headers";
import { signOut } from "@/lib/auth";
import { ACTIVE_ORG_COOKIE } from "@/lib/onboarding";
import { LAST_CHAT_COOKIE } from "@/lib/ask-last-chat";

/**
 * Sign out, from anywhere in the console.
 *
 * A plain form posting to /api/auth/signout is refused: Auth.js checks the
 * body for the CSRF token its own page would have carried, and a hand-written
 * form has none, so the button did nothing. Going through signOut() here
 * signs the session out on the server and never needs the token.
 *
 * The active-org cookie goes with it. It is only a preference and every read
 * re-checks membership, but leaving one person's last org on a shared machine
 * for the next person to sign in on is untidy. So does the last Ask Jimmy
 * chat: the next session starts a new one.
 */
export async function signOutAction(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACTIVE_ORG_COOKIE);
  // A new session opens a new chat.
  jar.delete(LAST_CHAT_COOKIE);
  await signOut({ redirectTo: "/signin" });
}
