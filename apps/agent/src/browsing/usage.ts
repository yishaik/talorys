import type { SettingsService } from "../services/settings";
import { UsageService } from "../services/usage";

/** `tal_settings` key holding today's browsing counters. One small JSON row, reset each UTC day. */
export const BROWSING_USAGE_KEY = "browsing.usage";

export type BrowseEngine = "kitesurf" | "chromium" | "fetch";

export interface BrowsingUsage {
  /** UTC day (YYYY-MM-DD) the counters belong to; Browser Run's free allowance resets at UTC midnight too. */
  day: string;
  /** browse_page calls that passed the URL check (counted against maxPagesPerDay). */
  pages: number;
  kitesurf: number;
  chromium: number;
  fetch: number;
  /** Kitesurf attempts that failed or could not render the page. */
  kitesurf_failures: number;
  /** Browser time Browser Run reported (X-Browser-Ms-Used), all engines. */
  browser_ms: number;
}

const empty = (day: string): BrowsingUsage => ({ day, pages: 0, kitesurf: 0, chromium: 0, fetch: 0, kitesurf_failures: 0, browser_ms: 0 });

/** Today's counters; a row from an earlier day reads as zero. */
export function browsingUsageToday(settings: SettingsService, date = new Date()): BrowsingUsage {
  const day = UsageService.day(date);
  const stored = settings.getJson<Partial<BrowsingUsage>>(BROWSING_USAGE_KEY);
  if (!stored || stored.day !== day) return empty(day);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    day,
    pages: n(stored.pages),
    kitesurf: n(stored.kitesurf),
    chromium: n(stored.chromium),
    fetch: n(stored.fetch),
    kitesurf_failures: n(stored.kitesurf_failures),
    browser_ms: n(stored.browser_ms),
  };
}

/** Adds to today's counters. The Durable Object runs one request at a time, so read-modify-write is safe. */
export function recordBrowsing(settings: SettingsService, delta: Partial<Omit<BrowsingUsage, "day">>, date = new Date()): BrowsingUsage {
  const next = browsingUsageToday(settings, date);
  for (const [k, v] of Object.entries(delta) as [keyof Omit<BrowsingUsage, "day">, number][]) {
    if (typeof v === "number" && Number.isFinite(v)) next[k] += Math.max(0, Math.round(v));
  }
  settings.setJson(BROWSING_USAGE_KEY, next);
  return next;
}

/** Usage deltas for a set of engine attempts. */
export function tallyAttempts(attempts: { engine: string; ok: boolean; browserMs?: number }[]): Omit<BrowsingUsage, "day" | "pages"> {
  const t = { kitesurf: 0, chromium: 0, fetch: 0, kitesurf_failures: 0, browser_ms: 0 };
  for (const a of attempts) {
    if (a.engine === "kitesurf" || a.engine === "chromium" || a.engine === "fetch") t[a.engine]++;
    if (a.engine === "kitesurf" && !a.ok) t.kitesurf_failures++;
    t.browser_ms += a.browserMs ?? 0;
  }
  return t;
}
