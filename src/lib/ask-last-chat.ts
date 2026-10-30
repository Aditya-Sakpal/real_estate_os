/**
 * The chat Ask Jimmy opens on: the one this person last had on screen, for
 * as long as the browser session lasts.
 *
 * Leaving Ask Jimmy for another screen and coming back used to open a new,
 * empty chat. It now reopens the last one, the way ChatGPT does. A new chat
 * starts only from "New chat", or in a new session: the cookie carries no
 * expiry, so it ends when the browser does, and signing out removes it.
 *
 * The cookie names a chat id and nothing else. The page reads the chat back
 * through the person's own access (`loadThread()`), so an id that is not
 * theirs, or a chat since deleted or expired, simply opens a new chat.
 */
export const LAST_CHAT_COOKIE = "salesdesk.ask";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id a cookie holds, or null for anything that is not one. */
export function lastChatId(raw: string | null | undefined): string | null {
  return raw && UUID.test(raw) ? raw : null;
}

/** Remember the chat on screen, or forget it when a new one is started. Browser only. */
export function rememberChat(id: string | null): void {
  try {
    document.cookie = id
      ? `${LAST_CHAT_COOKIE}=${id}; path=/; samesite=lax`
      : `${LAST_CHAT_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } catch {
    // A browser refusing cookies opens a new chat each time, as before.
  }
}
