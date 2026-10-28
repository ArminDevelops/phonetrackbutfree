import { randomBytes as cryptoRandomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SETTING = "ntfy_topic";

/** Anyone who knows an ntfy.sh topic can read it, so make it unguessable (120 bits). */
export function generateTopic(randomBytes: (n: number) => Uint8Array = cryptoRandomBytes): string {
  const bytes = randomBytes(24);
  return `apple-ch-${Array.from(bytes, (b) => ALPHABET[b % 32]).join("")}`;
}

export function resolveTopic(config: Config, repo: Repo): string {
  if (config.ntfyTopic) return config.ntfyTopic;
  const stored = repo.getSetting(SETTING);
  if (stored) return stored;
  const topic = generateTopic();
  repo.setSetting(SETTING, topic);
  return topic;
}
