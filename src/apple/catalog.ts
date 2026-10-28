import { cleanText } from "./pickup.js";
import type { CatalogItem } from "./types.js";

export { buyLink } from "./links.js";

const SLUG_PATTERN = /\/ch-de\/shop\/buy-iphone\/(iphone-[a-z0-9-]+)/g;
const TITLE_PATTERN = /^(.*?)\s(\d+\s?(?:GB|TB))\s(.+)$/;
const PART_PATTERN = /^[A-Z0-9]{4,7}[A-Z]{0,3}\/A$/;

/** iPhone model slugs linked from /ch-de/shop/buy-iphone, in page order. */
export function parseModelSlugs(html: string): string[] {
  return [...new Set([...html.matchAll(SLUG_PATTERN)].map((m) => m[1]!))];
}

/** "iphone-18-pro" → "iphone18pro" (holds for every current model). */
export function familyFromSlug(slug: string): string {
  return slug.replace(/-/g, "");
}

/** "iPhone 18 Pro Max 1 TB Schwarz" → model, capacity and color labels. */
export function parseTitle(title: string): { modelName: string; capacityLabel: string; colorLabel: string } {
  const clean = cleanText(title);
  const match = TITLE_PATTERN.exec(clean);
  if (!match) return { modelName: clean, capacityLabel: "", colorLabel: "" };
  return { modelName: match[1]!, capacityLabel: match[2]!, colorLabel: match[3]! };
}

interface RawProduct {
  partNumber?: string;
  productTitle?: string;
  dimensionColor?: string;
  dimensionCapacity?: string;
  dimensionScreensize?: string;
  price?: string;
  image?: string;
  productLink?: string;
}

/** Parses /ch-de/shop/product-locator-meta?family=…; null when Apple returned no product list. */
export function parseLocatorMeta(json: unknown, family: string, sortOrder: number): CatalogItem[] | null {
  const products = (json as { body?: { productLocatorOverlayData?: { productLocatorMeta?: { products?: RawProduct[] } } } })
    ?.body?.productLocatorOverlayData?.productLocatorMeta?.products;
  if (!Array.isArray(products)) return null;

  return products
    .filter((p) => p.partNumber && p.productTitle)
    .map((p) => {
      const title = cleanText(p.productTitle!);
      const { modelName, capacityLabel, colorLabel } = parseTitle(title);
      const price = p.price ? Number(p.price.replace("_", ".")) : NaN;
      return {
        partNumber: p.partNumber!,
        family,
        modelName,
        title,
        colorKey: p.dimensionColor ?? "",
        colorLabel,
        capacityKey: p.dimensionCapacity ?? "",
        capacityLabel,
        screensizeKey: p.dimensionScreensize ?? null,
        priceChf: Number.isFinite(price) ? price : null,
        imageKey: p.image ?? null,
        productLink: p.productLink ?? `https://www.apple.com/ch-de/shop/product/${p.partNumber}`,
        sortOrder,
      };
    });
}

export function imageUrl(imageKey: string): string {
  return `https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/${imageKey}?wid=240&hei=240&fmt=png-alpha`;
}

/** Upper-cases and validates a hand-entered part number such as "MK2D4QL/A". */
export function normalizePartNumber(input: string): string | null {
  const part = input.trim().toUpperCase();
  return PART_PATTERN.test(part) ? part : null;
}
