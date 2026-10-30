/**
 * Where a site is, as a buyer's phone will find it. Pure and database-free,
 * covered by `check:logic`.
 *
 * A developer pastes whatever Google Maps gave them: a share link
 * (maps.app.goo.gl), a place link with the pin in it (`@18.52,73.85,17z`),
 * a search link, or two numbers. The pin is kept when it can be read, because
 * a directions link to a pin opens navigation on the phone in one tap. A
 * short share link cannot be read without following it, so it is kept as
 * the link and sent as it is.
 */

export type SiteLocation = {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** The link a buyer taps. */
  mapsUrl: string;
};

const PIN = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;

function pinOk(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/** The pin in a Maps link or a pair of numbers, or null. */
export function pinFrom(raw: string): { latitude: number; longitude: number } | null {
  const s = raw.trim();
  const at = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(s);
  const q = /[?&](?:q|query|destination|ll|center)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i.exec(s);
  const d = /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(s);
  const bare = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/.exec(s);
  // A place link carries both the viewport (`@`) and the pin (`!3d!4d`); the
  // pin is the building, the viewport is wherever the map happened to be.
  const m = d ?? q ?? at ?? bare ?? PIN.exec(s);
  if (!m) return null;
  const latitude = Number(Number(m[1]).toFixed(6));
  const longitude = Number(Number(m[2]).toFixed(6));
  return pinOk(latitude, longitude) ? { latitude, longitude } : null;
}

/** A Google Maps link we will send, or null for anything that is not one. */
export function mapsLinkFrom(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const google =
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "maps.google.com" ||
    host === "g.co" ||
    ((host === "google.com" || host.startsWith("www.google.") || host.startsWith("google.")) && u.pathname.startsWith("/maps"));
  if (!google || u.username || u.password) return null;
  u.protocol = "https:";
  const out = u.toString();
  return out.length <= 500 ? out : null;
}

/** One tap to navigation, from a pin. */
export function directionsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`;
}

/**
 * What a person typed, as a location we can store, or why not. Either a
 * Maps link or a pin is enough; an address alone is not, because "Survey
 * No. 42, Hinjewadi Phase 3" does not open navigation.
 */
export function readLocation(input: { link: string; address: string }):
  | { ok: true; location: SiteLocation }
  | { ok: false; message: string } {
  const address = input.address.trim().replace(/\s+/g, " ").slice(0, 300) || null;
  const link = input.link.trim();
  if (!link) return { ok: false, message: "Paste the Google Maps link to the site, or its pin as two numbers." };
  const pin = pinFrom(link);
  const maps = mapsLinkFrom(link);
  if (!pin && !maps) {
    return { ok: false, message: "That is not a Google Maps link. Open the site in Google Maps, press Share, and paste the link." };
  }
  return {
    ok: true,
    location: {
      address,
      latitude: pin?.latitude ?? null,
      longitude: pin?.longitude ?? null,
      mapsUrl: pin ? directionsUrl(pin.latitude, pin.longitude) : maps!,
    },
  };
}
