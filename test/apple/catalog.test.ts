import { expect, test } from "vitest";
import {
  familyFromSlug,
  imageUrl,
  normalizePartNumber,
  parseLocatorMeta,
  parseModelSlugs,
  parseTitle,
} from "../../src/apple/catalog.js";
import { fixture, fixtureJson } from "../helpers/fixtures.js";

test("model slugs from the buy-iphone page", () => {
  expect(parseModelSlugs(fixture("buy-iphone-index.html"))).toEqual([
    "iphone-duo",
    "iphone-18-pro",
    "iphone-air",
    "iphone-17",
    "iphone-17e",
    "iphone-16",
  ]);
});

test("family from slug", () => {
  expect(familyFromSlug("iphone-18-pro")).toBe("iphone18pro");
});

test.each([
  ["iPhone 18 Pro Max 1 TB Schwarz", { modelName: "iPhone 18 Pro Max", capacityLabel: "1 TB", colorLabel: "Schwarz" }],
  ["iPhone 16 128 GB Weiß", { modelName: "iPhone 16", capacityLabel: "128 GB", colorLabel: "Weiß" }],
  ["iPhone Air 256 GB Space Schwarz", { modelName: "iPhone Air", capacityLabel: "256 GB", colorLabel: "Space Schwarz" }],
  ["AirPods Pro 3", { modelName: "AirPods Pro 3", capacityLabel: "", colorLabel: "" }],
])("parseTitle(%s)", (title, expected) => {
  expect(parseTitle(title)).toEqual(expected);
});

test("Duo catalog", () => {
  const items = parseLocatorMeta(fixtureJson("product-locator-meta-iphoneduo.json"), "iphoneduo", 0)!;
  expect(items).toHaveLength(8);
  expect(items.find((i) => i.partNumber === "MK2D4QL/A")).toEqual({
    partNumber: "MK2D4QL/A",
    family: "iphoneduo",
    modelName: "iPhone Duo",
    title: "iPhone Duo 256 GB Sternenweiß",
    colorKey: "starwhite",
    colorLabel: "Sternenweiß",
    capacityKey: "256gb",
    capacityLabel: "256 GB",
    screensizeKey: null,
    priceChf: 1999,
    imageKey: "iphone-duo-finish-select-star-white-202609",
    productLink: "https://www.apple.com/ch-de/shop/buy-iphone/iphone-duo/7,6%E2%80%9D-display-256gb-sternenwei%C3%9F",
    sortOrder: 0,
  });
});

test("Pro and Pro Max share a family but get their own model names", () => {
  const items = parseLocatorMeta(fixtureJson("product-locator-meta-iphone18pro.json"), "iphone18pro", 1)!;
  expect(items).toHaveLength(32);
  expect(new Set(items.map((i) => i.modelName))).toEqual(new Set(["iPhone 18 Pro", "iPhone 18 Pro Max"]));
  expect(items.find((i) => i.partNumber === "MJRY4QL/A")?.screensizeKey).toBe("6_3inch");
});

test("unknown family gives null", () => {
  expect(parseLocatorMeta(fixtureJson("product-locator-meta-unknown-family.json"), "iphonefoo", 0)).toBeNull();
});

test("image url", () => {
  expect(imageUrl("iphone-duo-finish-select-star-white-202609")).toBe(
    "https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/iphone-duo-finish-select-star-white-202609?wid=240&hei=240&fmt=png-alpha",
  );
});

test.each([
  [" mk2d4ql/a ", "MK2D4QL/A"],
  ["MXP63ZM/A", "MXP63ZM/A"],
  ["hello", null],
  ["", null],
  ["MK2D4QL", null],
])("normalizePartNumber(%j)", (input, expected) => {
  expect(normalizePartNumber(input)).toBe(expected);
});
