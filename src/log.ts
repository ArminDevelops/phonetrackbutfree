function formatValue(value: unknown): string {
  if (typeof value === "string") return /[\s"=]/.test(value) || value === "" ? JSON.stringify(value) : value;
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** One line per event: `2026-10-28T14:05:00.000Z cycle.done requests=1 outcome=success`. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  console.log([new Date().toISOString(), event, ...parts].join(" "));
}
