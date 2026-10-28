import type { BatchResult, Observation, StoreInfo } from "./types.js";

export const APPLE_BASE = "https://www.apple.com/ch-de/shop/";
export const APPLE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
/** Apple silently drops parts beyond the 20th. */
export const MAX_PARTS_PER_REQUEST = 20;

export function buildPickupPath(parts: string[], location: string): string {
  if (parts.length === 0 || parts.length > MAX_PARTS_PER_REQUEST) {
    throw new Error(`pickup request needs 1-${MAX_PARTS_PER_REQUEST} parts, got ${parts.length}`);
  }
  const query = parts.map((part, i) => `parts.${i}=${encodeURIComponent(part)}`).join("&");
  return `retail/pickup-message?pl=true&mts.0=regular&${query}&location=${encodeURIComponent(location)}`;
}

interface RawPart {
  pickupDisplay?: string;
  pickupSearchQuote?: string;
  messageTypes?: { regular?: { storePickupProductTitle?: string } };
}

interface RawStore {
  storeNumber?: string;
  storeName?: string;
  city?: string;
  partsAvailability?: Record<string, RawPart>;
}

/** Apple separates "256" and "GB" with U+00A0; normalize so titles compare and print predictably. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Parses a 200 response body. Status-code handling lives in the client. */
export function parsePickupJson(text: string): BatchResult {
  let json: { body?: { stores?: RawStore[]; errorMessage?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "error", message: "Apple returned non-JSON" };
  }

  const rawStores = json?.body?.stores;
  if (!Array.isArray(rawStores) || rawStores.length === 0) {
    const message = json?.body?.errorMessage;
    return message ? { kind: "empty", message } : { kind: "empty" };
  }

  const stores: StoreInfo[] = [];
  const observations: Observation[] = [];
  for (const raw of rawStores) {
    if (!raw.storeNumber) continue;
    stores.push({ storeNumber: raw.storeNumber, name: raw.storeName ?? raw.storeNumber, city: raw.city ?? "" });
    for (const [partNumber, part] of Object.entries(raw.partsAvailability ?? {})) {
      const pickupDisplay = part.pickupDisplay ?? "";
      observations.push({
        partNumber,
        storeNumber: raw.storeNumber,
        status: pickupDisplay === "available" ? "available" : "unavailable",
        pickupDisplay,
        quote: cleanText(part.pickupSearchQuote ?? ""),
        productTitle: cleanText(part.messageTypes?.regular?.storePickupProductTitle ?? ""),
      });
    }
  }
  return { kind: "success", stores, observations };
}
