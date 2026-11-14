import { BlockedUrlError, checkPublicUrl } from "./url-guard";
import { htmlTitle, htmlToMarkdown } from "./text";
import type { BrowseEngine } from "./usage";

/**
 * The slice of the Browser Run binding (`env.BROWSER`, workers-types `BrowserRun`) this module
 * uses: the `markdown` Quick Action, which returns a `Response` holding
 * `{ success: true, result: string, meta: { status, title, finalUrl } }` or
 * `{ success: false, errors: [{ message }] }`, plus an `X-Browser-Ms-Used` header.
 */
export interface QuickActionBinding {
  quickAction(
    action: "markdown",
    options: { url: string; browser?: "kitesurf"; gotoOptions?: { timeout?: number; waitUntil?: "domcontentloaded" | "load" }; cacheTTL?: number },
  ): Promise<Response>;
}

export interface BrowseDeps {
  /** The Browser Run binding; without it only the plain fetch engine is used. */
  browser?: QuickActionBinding | null;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface BrowsePolicy {
  /** Retry with Browser Run's default Chromium when Kitesurf cannot render the page. */
  chromium: boolean;
  /** Whole-call timeout per engine attempt, ms. */
  timeoutMs?: number;
}

export interface EngineAttempt {
  engine: BrowseEngine;
  ok: boolean;
  /** Why the attempt did not produce the page. */
  reason?: string;
  ms: number;
  /** Browser time Browser Run reported for the attempt. */
  browserMs?: number;
}

export interface BrowseResult {
  engine: BrowseEngine;
  markdown: string;
  title: string;
  /** HTTP status of the page itself. */
  status: number;
  finalUrl: string;
  attempts: EngineAttempt[];
}

/** Thrown when no engine could read the page; carries every attempt for the model and the logs. */
export class BrowseFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: EngineAttempt[],
  ) {
    super(message);
    this.name = "BrowseFailedError";
  }
}

export const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 3;
const MAX_FETCH_BYTES = 2_000_000;
/** Statuses that usually mean a bot wall Kitesurf cannot pass (it has no real TLS fingerprint). */
const BLOCKED_PAGE_STATUSES = new Set([401, 403, 429, 503]);
export const FETCH_USER_AGENT = "Mozilla/5.0 (compatible; TalorysBot/0.1; +https://github.com/yishaik/talorys)";

type Failure = { reason: string; rateLimited?: boolean; browserMs?: number };

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** One Browser Run `markdown` Quick Action; returns the page or a classified failure. */
async function viaBrowserRun(binding: QuickActionBinding, url: URL, engine: "kitesurf" | "chromium", timeoutMs: number): Promise<{ page: Omit<BrowseResult, "attempts" | "engine">; browserMs?: number } | Failure> {
  let res: Response;
  try {
    res = await withTimeout(
      binding.quickAction("markdown", {
        url: url.toString(),
        ...(engine === "kitesurf" ? { browser: "kitesurf" as const } : {}),
        gotoOptions: { timeout: Math.max(5_000, timeoutMs - 5_000), waitUntil: "domcontentloaded" },
        cacheTTL: 300,
      }),
      timeoutMs,
      `${engine === "kitesurf" ? "Kitesurf" : "Chromium"} rendering`,
    );
  } catch (e) {
    return { reason: errorText(e) };
  }
  const ms = Number(res.headers.get("x-browser-ms-used"));
  const browserMs = Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  let body: { success?: boolean; result?: unknown; errors?: { message?: string }[]; meta?: { status?: number; title?: string; finalUrl?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 429) return { reason: "Browser Run rate limit or daily browser time reached (429)", rateLimited: true, browserMs };
  if (!res.ok || body.success !== true || typeof body.result !== "string") {
    const msg = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
    return { reason: `Browser Run error: ${msg}`.slice(0, 300), browserMs };
  }
  const status = typeof body.meta?.status === "number" ? body.meta.status : 200;
  const finalUrl = body.meta?.finalUrl || url.toString();
  // The browser followed redirects on its own; refuse a page that ended on an internal host.
  checkPublicUrl(finalUrl);
  if (BLOCKED_PAGE_STATUSES.has(status)) return { reason: `the site answered ${status} (likely a bot check)`, browserMs };
  if (status < 400 && body.result.trim().length < 20) return { reason: "the page rendered empty", browserMs };
  return { page: { markdown: body.result, title: body.meta?.title ?? "", status, finalUrl }, browserMs };
}

/** A plain Worker fetch, following up to three redirects and checking every hop. */
async function viaFetch(doFetch: typeof fetch, url: URL, timeoutMs: number): Promise<{ page: Omit<BrowseResult, "attempts" | "engine"> } | Failure> {
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await withTimeout(
        doFetch(current.toString(), {
          redirect: "manual",
          headers: { "user-agent": FETCH_USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "he,en;q=0.8" },
        }),
        timeoutMs,
        "Fetching the page",
      );
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop === MAX_REDIRECTS) return { reason: "too many redirects" };
        current = checkPublicUrl(new URL(res.headers.get("location")!, current).toString());
        continue;
      }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      const isHtml = type.includes("html") || type === "";
      const isText = type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("markdown");
      if (!isHtml && !isText) {
        await res.body?.cancel();
        return { reason: `not a text page (${type.split(";")[0]})` };
      }
      const raw = await readCapped(res, MAX_FETCH_BYTES);
      const markdown = isHtml ? htmlToMarkdown(raw, current.toString()) : raw.trim();
      if (res.status < 400 && markdown.length < 20) return { reason: "the page has no readable text without JavaScript" };
      return { page: { markdown, title: isHtml ? htmlTitle(raw) : "", status: res.status, finalUrl: current.toString() } };
    }
    return { reason: "too many redirects" };
  } catch (e) {
    if (e instanceof BlockedUrlError) throw e;
    return { reason: errorText(e) };
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= max) await reader.cancel();
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const take = c.subarray(0, Math.min(c.byteLength, all.byteLength - off));
    all.set(take, off);
    off += take.byteLength;
    if (off >= all.byteLength) break;
  }
  return new TextDecoder("utf-8").decode(all);
}

/**
 * Reads a public page: Kitesurf first (free in beta), then — only when `policy.chromium` — one
 * Chromium retry, then a plain fetch. Without a binding only the plain fetch runs. A 429 from
 * Browser Run skips Chromium (it shares the account's Quick Action rate and browser time).
 * Throws BlockedUrlError for refused URLs and BrowseFailedError when every engine failed.
 */
export async function browse(rawUrl: string, deps: BrowseDeps, policy: BrowsePolicy): Promise<BrowseResult> {
  const url = checkPublicUrl(rawUrl);
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts: EngineAttempt[] = [];
  const run = async <R extends object>(engine: BrowseEngine, work: () => Promise<R | Failure>): Promise<R | null> => {
    const started = Date.now();
    const out = await work();
    const ms = Date.now() - started;
    if ("reason" in out) {
      attempts.push({ engine, ok: false, reason: out.reason, ms, ...(out.browserMs !== undefined ? { browserMs: out.browserMs } : {}) });
      return null;
    }
    const browserMs = (out as { browserMs?: number }).browserMs;
    attempts.push({ engine, ok: true, ms, ...(browserMs !== undefined ? { browserMs } : {}) });
    return out;
  };
  const done = (engine: BrowseEngine, page: Omit<BrowseResult, "attempts" | "engine">): BrowseResult => ({ engine, ...page, attempts });

  if (deps.browser) {
    const k = await run("kitesurf", () => viaBrowserRun(deps.browser!, url, "kitesurf", timeoutMs));
    if (k) return done("kitesurf", k.page);
    const rateLimited = attempts.at(-1)?.reason?.includes("(429)") ?? false;
    if (policy.chromium && !rateLimited) {
      const c = await run("chromium", () => viaBrowserRun(deps.browser!, url, "chromium", timeoutMs));
      if (c) return done("chromium", c.page);
    }
  }
  const f = await run("fetch", () => viaFetch(deps.fetch ?? fetch, url, Math.min(timeoutMs, 15_000)));
  if (f) return done("fetch", f.page);
  const why = attempts.map((a) => `${a.engine}: ${a.reason}`).join("; ");
  throw new BrowseFailedError(`The page could not be read (${why}).`, attempts);
}
