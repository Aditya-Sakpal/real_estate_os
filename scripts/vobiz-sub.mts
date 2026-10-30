/**
 * The operator's view of a client's Vobiz sub-account: its id, where its KYC
 * stands, and its token, for adding the client's own Sarvam connection by
 * hand (Sarvam publishes no API for it yet). Prints the token to this
 * terminal only; never paste it into an email or a chat.
 *
 *   npm run vobiz:sub -- --org <org id>
 */
import { kycView, subCredentials } from "../src/lib/calling-kyc.ts";
import { closeDb } from "../src/lib/db/index.ts";

const org = process.argv[process.argv.indexOf("--org") + 1];
if (!org || !/^[0-9a-f-]{36}$/i.test(org)) {
  console.error("usage: npm run vobiz:sub -- --org <org id>");
  process.exit(1);
}
const kyc = await kycView(org, { refresh: true });
if (!kyc) {
  console.log("This organisation has not started its business verification.");
} else {
  const creds = await subCredentials(org);
  console.log(`KYC          ${kyc.status}${kyc.blocked ? " (calls blocked)" : ""}`);
  console.log(`Auth ID      ${creds?.authId ?? "(not readable)"}`);
  console.log(`Auth token   ${creds?.authToken ?? "(not readable)"}`);
}
await closeDb();
