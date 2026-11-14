/**
 * Text shaping for `browse_page`: a rough HTML → Markdown for the plain-fetch fallback, link
 * extraction, and token-saving cleanup of Browser Run's Markdown (inline link targets and images
 * are dropped from the body; the links come back as a separate, bounded list when asked for).
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", shy: "" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The page title from raw HTML, if any. */
export function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]!.replace(/\s+/g, " ").trim()).slice(0, 300) : "";
}

/** A readable Markdown-ish rendering of an HTML document: headings, paragraphs, list items, links. */
export function htmlToMarkdown(html: string, base: string): string {
  let s = html;
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(s);
  if (bodyMatch) s = bodyMatch[1]!;
  s = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|head|form|select|button)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${inner}\n\n`);
  s = s.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_, a?: string, b?: string, c?: string, inner?: string) => {
    const href = decodeEntities((a ?? b ?? c ?? "").trim());
    const text = (inner ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    let abs = "";
    try {
      abs = new URL(href, base).toString();
    } catch {
      /* not a URL */
    }
    return text && /^https?:/i.test(abs) ? `[${text}](${abs})` : text;
  });
  s = s
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|main|aside|li|ul|ol|table|tr|blockquote|pre|dd|dt|figure|figcaption)>/gi, "\n\n")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(s));
}

function tidy(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PageLink {
  text: string;
  url: string;
}

/** `[text](target "title")`; the target may hold one level of balanced parentheses (Wikipedia). */
const LINK_RE = /(!?)\[([^\]\n]{0,300})\]\((<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g;

/**
 * Splits Markdown into a compact body (link text kept, targets and images removed) and the list
 * of distinct http(s) links in reading order.
 */
export function compactMarkdown(markdown: string, base: string, maxLinks: number): { body: string; links: PageLink[] } {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const body = markdown.replace(LINK_RE, (_, bang: string, text: string, target: string) => {
    if (bang) return text.trim() ? `[image: ${text.trim()}]` : "";
    const clean = text.replace(/[*_`]/g, "").trim();
    let abs = "";
    try {
      abs = new URL(target.replace(/^<|>$/g, ""), base).toString();
    } catch {
      /* relative junk */
    }
    if (/^https?:/i.test(abs) && !seen.has(abs) && links.length < maxLinks) {
      seen.add(abs);
      links.push({ text: clean.slice(0, 120) || abs, url: abs });
    }
    return clean;
  });
  return { body: tidy(body), links };
}
