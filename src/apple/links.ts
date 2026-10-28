import { APPLE_BASE } from "./pickup.js";

/** Apple redirects this to the preselected buy page for any Swiss part number. */
export function buyLink(partNumber: string): string {
  return `${APPLE_BASE}product/${partNumber}`;
}
