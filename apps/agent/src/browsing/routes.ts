import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/app";
import { AppError, ValidationError } from "../api/errors";
import { body } from "../api/middleware";
import { browse, BrowseFailedError } from "./engine";
import { browserBinding } from "./index";
import { compactMarkdown } from "./text";
import { BlockedUrlError } from "./url-guard";
import { browsingUsageToday, recordBrowsing, tallyAttempts } from "./usage";

/** Owner-only browsing API (session and CSRF from `createApi`): status for Settings, and a test read. */
export const browsingRoutes = new Hono<AppEnv>();

browsingRoutes.get("/browsing/status", (c) => {
  const s = c.env.agent.services;
  return c.json({
    settings: s.settings.get().browsing,
    binding: browserBinding(c.env.env) !== null,
    engine: browserBinding(c.env.env) ? "kitesurf" : "fetch",
    usage: browsingUsageToday(s.settings),
  });
});

/**
 * Reads one page the way browse_page does, without a model: for checking a deploy and Kitesurf
 * compatibility of a site. Counts against the same daily limits.
 */
browsingRoutes.post("/browsing/test", async (c) => {
  const input = await body(c, z.object({ url: z.string().min(4).max(2000), chromium: z.boolean().optional() }));
  const s = c.env.agent.services;
  const settings = s.settings.get().browsing;
  const usage = browsingUsageToday(s.settings);
  if (usage.pages >= settings.maxPagesPerDay) throw new AppError("CONFLICT", "The daily browsing limit is reached.");
  const chromium = (input.chromium ?? settings.chromiumFallback) && usage.chromium < settings.maxChromiumPerDay;
  const started = Date.now();
  try {
    const r = await browse(input.url, { browser: browserBinding(c.env.env) }, { chromium });
    const t = tallyAttempts(r.attempts);
    recordBrowsing(s.settings, { pages: 1, ...t });
    const { body: text, links } = compactMarkdown(r.markdown, r.finalUrl, 10);
    return c.json({ ok: true, engine: r.engine, status: r.status, title: r.title, final_url: r.finalUrl, total_ms: Date.now() - started, attempts: r.attempts, total_chars: text.length, links: links.length, excerpt: text.slice(0, 600) });
  } catch (error) {
    if (error instanceof BlockedUrlError) throw new ValidationError(error.message);
    if (error instanceof BrowseFailedError) {
      recordBrowsing(s.settings, { pages: 1, ...tallyAttempts(error.attempts) });
      return c.json({ ok: false, error: error.message, total_ms: Date.now() - started, attempts: error.attempts });
    }
    throw error;
  }
});
