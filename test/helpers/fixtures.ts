import { readFileSync } from "node:fs";

export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/apple/${name}`, import.meta.url), "utf8");
}

export function fixtureJson(name: string): any {
  return JSON.parse(fixture(name));
}
