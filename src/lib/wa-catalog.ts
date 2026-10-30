import { CATALOG, type Template } from "./message-rules.ts";
import { BROADCAST_CATALOG } from "./broadcast-rules.ts";

/**
 * Every template a developer's WhatsApp account is asked to hold: the lead
 * engine's messages in their three versions, and the broadcast message in
 * its two wordings and three versions. What is submitted to Meta, tracked,
 * and approved for sending is this one list.
 */
export const SUBMITTED: readonly Template[] = [...CATALOG, ...BROADCAST_CATALOG];
