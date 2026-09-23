export type QuotaLabel = "5h" | "Daily" | "Weekly" | "Monthly"

export type QuotaWindow = {
  percent: number
  resetsAt: number
  label?: QuotaLabel
}

export function quotaLabelForSeconds(seconds: unknown): QuotaLabel | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined
  if (seconds <= 6 * 60 * 60) return "5h"
  if (seconds <= 2 * 24 * 60 * 60) return "Daily"
  if (seconds <= 8 * 24 * 60 * 60) return "Weekly"
  return "Monthly"
}

export function parseWhamWindow(window: unknown, now: number): QuotaWindow | null {
  if (!window || typeof window !== "object") return null
  const value = window as {
    used_percent?: unknown
    reset_at?: unknown
    reset_after_seconds?: unknown
    limit_window_seconds?: unknown
  }
  if (typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)) return null
  const resetsAt =
    typeof value.reset_at === "number" && Number.isFinite(value.reset_at)
      ? value.reset_at * 1000
      : typeof value.reset_after_seconds === "number" &&
          Number.isFinite(value.reset_after_seconds)
        ? now + value.reset_after_seconds * 1000
        : undefined
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return null
  const label = quotaLabelForSeconds(value.limit_window_seconds)
  return {
    percent: Math.min(100, Math.max(0, value.used_percent)),
    resetsAt,
    ...(label ? { label } : {}),
  }
}

export function parseWhamUsage(data: unknown, now: number): QuotaWindow[] {
  if (!data || typeof data !== "object") return []
  const rateLimit = (data as { rate_limit?: { primary_window?: unknown; secondary_window?: unknown } }).rate_limit
  return [
    { fallback: "Daily" as const, window: parseWhamWindow(rateLimit?.primary_window, now) },
    { fallback: "Weekly" as const, window: parseWhamWindow(rateLimit?.secondary_window, now) },
  ].flatMap(({ fallback, window }) => window ? [{ ...window, label: window.label ?? fallback }] : [])
}
