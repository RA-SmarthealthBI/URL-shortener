export type Device = "desktop" | "mobile" | "tablet" | "bot" | "unknown";

// Link-preview fetchers (Slack, WhatsApp, iMessage...) hit a link when it is
// pasted, not when a person clicks it. They are logged but kept separate.
const BOT =
  /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|embedly|preview|whatsapp|skypeuripreview|vkshare|pinterest|bitlybot|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|java\/|httpclient|headless|lighthouse/i;
const TABLET = /ipad|tablet|kindle|silk\/|playbook|android(?!.*mobi)/i;
const MOBILE = /mobi|iphone|ipod|windows phone|blackberry|bb10|opera mini|iemobile/i;

/**
 * Coarse device class from the User-Agent. Known blind spot: iPadOS 13+
 * sends a desktop Safari UA by default, so most iPads count as desktop.
 */
export function deviceFromUA(ua: string | null): Device {
  if (!ua) return "unknown";
  if (BOT.test(ua)) return "bot";
  if (TABLET.test(ua)) return "tablet";
  if (MOBILE.test(ua)) return "mobile";
  return "desktop";
}
