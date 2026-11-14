import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { browse, BrowseFailedError, type QuickActionBinding } from "../src/browsing/engine";
import { BROWSE_TOOL, browsingTools } from "../src/browsing/tools";
import { BlockedUrlError, blockedHostReason, checkPublicUrl } from "../src/browsing/url-guard";
import { compactMarkdown, htmlToMarkdown } from "../src/browsing/text";
import { BROWSING_USAGE_KEY, browsingUsageToday } from "../src/browsing/usage";
import { withBrowsing } from "../src/browsing";
import { buildSystemPrompt, BROWSE_ONLY_RULE, CONNECTOR_RULE, NO_ACCESS_RULE } from "../src/agent/prompt";
import { ALL_TOOLS, ToolExecutor, type ToolContext } from "../src/tools";
import type { Env } from "../src/env";
import type { Services } from "../src/services/container";

type Call = { action: string; options: Record<string, unknown> };

/** A Browser Run binding double: answers each call with the next scripted response. */
function mockBinding(responses: (Response | Error | ((o: Record<string, unknown>) => Response))[]) {
  const calls: Call[] = [];
  const binding: QuickActionBinding = {
    async quickAction(action, options) {
      calls.push({ action, options: options as Record<string, unknown> });
      const next = responses.shift();
      if (!next) throw new Error("unexpected quickAction call");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(options as Record<string, unknown>) : next;
    },
  };
  return { binding, calls };
}

const ok = (markdown: string, meta: Record<string, unknown> = {}, ms = 420) =>
  new Response(JSON.stringify({ success: true, result: markdown, meta: { status: 200, title: "Example Domain", ...meta } }), {
    headers: { "content-type": "application/json", "x-browser-ms-used": String(ms) },
  });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, errors: [{ message }] }), { status, headers: { "content-type": "application/json" } });

const PAGE = "# Example Domain\n\nThis domain is for use in illustrative examples in documents. [Learn more](https://iana.org/domains/example) ![logo](/logo.png)";

const noFetch = (async () => {
  throw new Error("fetch should not be called");
}) as unknown as typeof fetch;

function htmlFetch(html: string, status = 200, headers: Record<string, string> = {}) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  }) as unknown as typeof fetch;
  return { f, seen };
}

function resetBrowsing(s: Services) {
  s.settings.delete(BROWSING_USAGE_KEY);
  s.settings.update({ browsing: { enabled: true, chromiumFallback: false, maxPagesPerDay: 100, maxChromiumPerDay: 10 } });
}

describe("URL guard", () => {
  it("allows public http(s) pages, including Hebrew paths", () => {
    expect(checkPublicUrl("https://example.com/").hostname).toBe("example.com");
    expect(checkPublicUrl("https://he.wikipedia.org/wiki/תל_אביב-יפו").pathname).toContain("%D7%AA");
    expect(checkPublicUrl("http://example.com:8080/x#frag").hash).toBe("");
  });

  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://router.local/",
    "http://metadata.google.internal/",
    "http://intranet/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "https://example.com:22/",
    "not a url",
  ])("blocks %s", (url) => {
    expect(() => checkPublicUrl(url)).toThrow(BlockedUrlError);
  });

  it("explains why a host is refused", () => {
    expect(blockedHostReason("10.0.0.1")).toMatch(/private/);
    expect(blockedHostReason("printer.lan")).toMatch(/internal/);
    expect(blockedHostReason("example.org")).toBeNull();
  });
});

describe("text shaping", () => {
  it("drops link targets and images from the body and lists links separately", () => {
    const { body, links } = compactMarkdown(`${PAGE} [Wiki](https://he.wikipedia.org/wiki/תל_אביב_(פירוש))`, "https://example.com/", 10);
    expect(body).toContain("Learn more");
    expect(body).not.toContain("https://iana.org");
    expect(body).toContain("[image: logo]");
    expect(links).toEqual([
      { text: "Learn more", url: "https://iana.org/domains/example" },
      { text: "Wiki", url: new URL("https://he.wikipedia.org/wiki/תל_אביב_(פירוש)").toString() },
    ]);
  });

  it("turns HTML into readable Markdown without scripts or styles", () => {
    const md = htmlToMarkdown(
      `<html><head><title>x</title><style>.a{}</style></head><body><script>evil()</script><h1>שלום</h1><p>Hello &amp; welcome <a href="/about">About</a></p><ul><li>one</li><li>two</li></ul></body></html>`,
      "https://example.com/page",
    );
    expect(md).toContain("# שלום");
    expect(md).toContain("Hello & welcome [About](https://example.com/about)");
    expect(md).toContain("- one");
    expect(md).not.toContain("evil");
  });
});

describe("browse engine", () => {
  it("renders with Kitesurf through the markdown Quick Action", async () => {
    const { binding, calls } = mockBinding([ok(PAGE)]);
    const r = await browse("https://example.com/", { browser: binding, fetch: noFetch }, { chromium: false });
    expect(r.engine).toBe("kitesurf");
    expect(r.title).toBe("Example Domain");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe("markdown");
    expect(calls[0]!.options.browser).toBe("kitesurf");
    expect(calls[0]!.options.url).toBe("https://example.com/");
    expect(r.attempts[0]).toMatchObject({ engine: "kitesurf", ok: true, browserMs: 420 });
  });

  it("retries once with Chromium only when the fallback is on", async () => {
    const on = mockBinding([fail(422, "Kitesurf could not render the page"), ok(PAGE)]);
    const r = await browse("https://example.com/", { browser: on.binding, fetch: noFetch }, { chromium: true });
    expect(r.engine).toBe("chromium");
    expect(on.calls[1]!.options.browser).toBeUndefined();

    const off = mockBinding([fail(500, "boom")]);
    const { f, seen } = htmlFetch("<html><body><p>Plain fetch body that is long enough.</p></body></html>");
    const r2 = await browse("https://example.com/", { browser: off.binding, fetch: f }, { chromium: false });
    expect(r2.engine).toBe("fetch");
    expect(off.calls).toHaveLength(1);
    expect(seen).toEqual(["https://example.com/"]);
  });

  it("skips Chromium on a Browser Run 429 (same account allowance) and uses plain fetch", async () => {
    const { binding, calls } = mockBinding([fail(429, "Rate limit exceeded")]);
    const { f } = htmlFetch("<html><body><p>Fallback text from a plain fetch.</p></body></html>");
    const r = await browse("https://example.com/", { browser: binding, fetch: f }, { chromium: true });
    expect(r.engine).toBe("fetch");
    expect(calls).toHaveLength(1);
    expect(r.attempts[0]!.reason).toContain("429");
  });

  it("falls back when Kitesurf hits a bot wall, throws, or renders nothing", async () => {
    for (const first of [ok("Just a moment...", { status: 403 }), new Error("socket hang up"), ok("   ")]) {
      const { binding } = mockBinding([first, ok(PAGE)]);
      const r = await browse("https://example.com/", { browser: binding, fetch: noFetch }, { chromium: true });
      expect(r.engine).toBe("chromium");
    }
  });

  it("returns a real 404 page instead of falling back", async () => {
    const { binding, calls } = mockBinding([ok("# Not found\n\nThe page you asked for does not exist.", { status: 404 })]);
    const r = await browse("https://example.com/missing", { browser: binding, fetch: noFetch }, { chromium: true });
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("refuses a page whose browser redirect ended on an internal host", async () => {
    const { binding } = mockBinding([ok(PAGE, { finalUrl: "http://169.254.169.254/" })]);
    await expect(browse("https://example.com/", { browser: binding, fetch: noFetch }, { chromium: false })).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("uses plain fetch without a binding and checks every redirect hop", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n === 1 ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }) : new Response("x");
    }) as unknown as typeof fetch;
    await expect(browse("https://example.com/", { browser: null, fetch: f }, { chromium: false })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(n).toBe(1);
  });

  it("times out a hanging engine and reports every attempt", async () => {
    const hang: QuickActionBinding = { quickAction: () => new Promise<Response>(() => {}) };
    const f = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const err = await browse("https://example.com/", { browser: hang, fetch: f }, { chromium: false, timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(BrowseFailedError);
    expect((err as BrowseFailedError).attempts.map((a) => a.engine)).toEqual(["kitesurf", "fetch"]);
    expect((err as Error).message).toMatch(/timed out/);
  });

  it("does not read binary pages with plain fetch", async () => {
    const f = (async () => new Response("PK", { headers: { "content-type": "application/zip" } })) as unknown as typeof fetch;
    await expect(browse("https://example.com/a.zip", { fetch: f }, { chromium: false })).rejects.toThrow(/not a text page/);
  });
});

describe("browse_page tool", () => {
  const ctxOf = (s: Services, mode: "chat" | "scheduled" = "chat"): ToolContext => ({ services: s, timezone: "UTC", mode, conversationId: "c1" });

  it("returns compact page text, paging and links, and counts usage", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      resetBrowsing(s);
      const long = `# Title\n\n${"שלום עולם. ".repeat(300)} [Next](https://example.com/next)`;
      const { binding } = mockBinding([ok(long, { finalUrl: "https://example.com/he" }, 900), ok(long, { finalUrl: "https://example.com/he" }, 800)]);
      const ex = new ToolExecutor(browsingTools({ browser: binding, fetch: noFetch }), ctxOf(s), { maxToolCalls: 10 });
      const first = (await ex.execute(BROWSE_TOOL, { url: "https://example.com/he", max_chars: 1000, include_links: true })) as Record<string, unknown>;
      expect(first.engine).toBe("kitesurf");
      expect((first.content as string).length).toBe(1000);
      expect(first.next_start).toBe(1000);
      expect(first.links).toEqual([{ text: "Next", url: "https://example.com/next" }]);
      const second = (await ex.execute(BROWSE_TOOL, { url: "https://example.com/he", start: 1000, max_chars: 1000 })) as Record<string, unknown>;
      expect(second.start).toBe(1000);
      expect(second.links).toBeUndefined();
      const u = browsingUsageToday(s.settings);
      expect(u).toMatchObject({ pages: 2, kitesurf: 2, chromium: 0, browser_ms: 1700 });
    });
  });

  it("gives the model a clear reason for blocked URLs without counting them", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      resetBrowsing(s);
      const ex = new ToolExecutor(browsingTools({ browser: null, fetch: noFetch }), ctxOf(s), { maxToolCalls: 10 });
      await expect(ex.execute(BROWSE_TOOL, { url: "http://192.168.1.1/" })).rejects.toThrow(/private or local network/);
      expect(browsingUsageToday(s.settings).pages).toBe(0);
    });
  });

  it("enforces the daily page cap and the Chromium cap", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      resetBrowsing(s);
      s.settings.update({ browsing: { maxPagesPerDay: 1, chromiumFallback: true, maxChromiumPerDay: 0 } });
      const { binding, calls } = mockBinding([fail(500, "boom")]);
      const { f } = htmlFetch("<html><body><p>Plain fetch body that is long enough.</p></body></html>");
      const ex = new ToolExecutor(browsingTools({ browser: binding, fetch: f }), ctxOf(s), { maxToolCalls: 10 });
      const r = (await ex.execute(BROWSE_TOOL, { url: "https://example.com/" })) as Record<string, unknown>;
      expect(r.engine).toBe("fetch"); // Chromium cap 0: no Chromium call
      expect(calls).toHaveLength(1);
      expect(r.note).toContain("kitesurf");
      await expect(ex.execute(BROWSE_TOOL, { url: "https://example.org/" })).rejects.toThrow(/daily browsing limit/);
    });
  });

  it("is off when the setting is off, and available to scheduled runs as a read tool", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      resetBrowsing(s);
      const env = {} as Env;
      const ext = withBrowsing(undefined, s, env);
      expect(ext?.browsing).toBe(true);
      expect(ext?.tools.map((t) => t.name)).toEqual([...ALL_TOOLS.map((t) => t.name), BROWSE_TOOL]);
      const scheduled = new ToolExecutor(ext!.tools, ctxOf(s, "scheduled"), { maxToolCalls: 4 });
      expect(scheduled.find(BROWSE_TOOL)).toBeDefined();
      s.settings.update({ browsing: { enabled: false } });
      expect(withBrowsing(undefined, s, env)).toBeUndefined();
      resetBrowsing(s);
    });
  });
});

describe("prompt", () => {
  const base = { agentName: "T", timezone: "UTC", now: new Date(0), autoMemory: false, memories: [] };
  it("says the agent can read web pages only when browse_page is listed", () => {
    expect(buildSystemPrompt(base)).toContain(NO_ACCESS_RULE);
    expect(buildSystemPrompt({ ...base, browsing: true })).toContain(BROWSE_ONLY_RULE);
    expect(buildSystemPrompt({ ...base, browsing: true })).not.toContain(NO_ACCESS_RULE);
    const both = buildSystemPrompt({ ...base, connectors: true, browsing: true });
    expect(both).toContain("browse_page");
    expect(both).not.toContain("browse arbitrary web pages");
    expect(buildSystemPrompt({ ...base, connectors: true })).toContain(CONNECTOR_RULE);
  });
});

describe("browsing API", () => {
  it("reports status and settings default on", async () => {
    const c = await loggedIn();
    const status = (await c.json("/api/browsing/status")) as { settings: { enabled: boolean; chromiumFallback: boolean }; binding: boolean; engine: string };
    expect(status.settings.enabled).toBe(true);
    expect(status.settings.chromiumFallback).toBe(false);
    expect(status.binding).toBe(false);
    expect(status.engine).toBe("fetch");
    const { settings } = (await c.json("/api/settings")) as { settings: { browsing: { enabled: boolean; maxPagesPerDay: number } } };
    expect(settings.browsing).toMatchObject({ enabled: true, maxPagesPerDay: 100 });
  });

  it("rejects internal URLs on the test route", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/browsing/test", { method: "POST", body: { url: "http://localhost:8787/api/health" } });
    expect(res.status).toBe(400);
  });
});
