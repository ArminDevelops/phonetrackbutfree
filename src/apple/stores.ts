import type { StoreInfo } from "./types.js";

/** The four Apple Stores in Switzerland (verified 2026-10-28), north-east to south-west. */
export const KNOWN_STORES: StoreInfo[] = [
  { storeNumber: "R159", name: "Rennweg", city: "Zürich" },
  { storeNumber: "R309", name: "Glattzentrum", city: "Wallisellen" },
  { storeNumber: "R439", name: "Freie Strasse", city: "Basel" },
  { storeNumber: "R275", name: "Rue de Rive", city: "Genève" },
];
