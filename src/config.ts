export interface Config {
  port: number;
  host: string;
  dataDir: string;
  pollIntervalSeconds: number;
  maxRequestsPerHour: number;
  appleLocation: string;
  ntfyServer: string;
  ntfyTopic: string | null;
  ntfyToken: string | null;
  renotifyCooldownMinutes: number;
  healthAlertAfterMinutes: number;
  pauseAlertAfterMinutes: number;
  heartbeatUrl: string | null;
}

type Env = Record<string, string | undefined>;

const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SWISS_POSTCODE = /^[1-9]\d{3}$/;

function text(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = text(env, key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

function matching(env: Env, key: string, pattern: RegExp, fallback: string | null): string | null {
  const raw = text(env, key);
  if (raw === null) return fallback;
  if (!pattern.test(raw)) throw new Error(`${key} has an invalid value "${raw}"`);
  return raw;
}

export function loadConfig(env: Env): Config {
  return {
    port: positiveInt(env, "PORT", 4321),
    host: text(env, "HOST") ?? "127.0.0.1",
    dataDir: text(env, "DATA_DIR") ?? "./data",
    pollIntervalSeconds: positiveInt(env, "POLL_INTERVAL_SECONDS", 30),
    maxRequestsPerHour: positiveInt(env, "MAX_REQUESTS_PER_HOUR", 150),
    appleLocation: matching(env, "APPLE_LOCATION", SWISS_POSTCODE, "8001")!,
    ntfyServer: (text(env, "NTFY_SERVER") ?? "https://ntfy.sh").replace(/\/+$/, ""),
    ntfyTopic: matching(env, "NTFY_TOPIC", TOPIC_PATTERN, null),
    ntfyToken: text(env, "NTFY_TOKEN"),
    renotifyCooldownMinutes: positiveInt(env, "RENOTIFY_COOLDOWN_MINUTES", 10),
    healthAlertAfterMinutes: positiveInt(env, "HEALTH_ALERT_AFTER_MINUTES", 15),
    pauseAlertAfterMinutes: positiveInt(env, "PAUSE_ALERT_AFTER_MINUTES", 30),
    heartbeatUrl: text(env, "HEARTBEAT_URL"),
  };
}
