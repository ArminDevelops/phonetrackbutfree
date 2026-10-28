export type PickupStatus = "available" | "unavailable";

export interface StoreInfo {
  storeNumber: string;
  name: string;
  city: string;
}

/** What Apple said about one part at one store in one response. */
export interface Observation {
  partNumber: string;
  storeNumber: string;
  status: PickupStatus;
  /** Raw `pickupDisplay`: available | unavailable | ineligible | … */
  pickupDisplay: string;
  /** Apple's `pickupSearchQuote`, e.g. "Verfügbar Heute". Display only. */
  quote: string;
  productTitle: string;
}

export type BatchResult =
  | { kind: "success"; stores: StoreInfo[]; observations: Observation[] }
  | { kind: "empty"; message?: string }
  | { kind: "blocked"; httpStatus: number }
  | { kind: "error"; message: string };

export interface CatalogItem {
  partNumber: string;
  family: string;
  modelName: string;
  title: string;
  colorKey: string;
  colorLabel: string;
  capacityKey: string;
  capacityLabel: string;
  screensizeKey: string | null;
  priceChf: number | null;
  imageKey: string | null;
  productLink: string;
  sortOrder: number;
}
