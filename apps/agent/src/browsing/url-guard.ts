/**
 * Which URLs `browse_page` may open: public http(s) pages only. Private, loopback, link-local,
 * CGNAT, metadata and other internal hosts are refused before any request is made, and again on
 * every redirect hop and on the browser's final URL. Names are checked as written (the WHATWG URL
 * parser already turns `http://2130706433/` and `http://0x7f.1/` into `127.0.0.1`); a public
 * name that resolves to a private address (DNS rebinding) is not caught here, which is acceptable
 * because Browser Run and Worker `fetch()` run on Cloudflare's network, not on the owner's LAN.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".private", ".home.arpa", ".onion"];
const BLOCKED_NAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "ip6-localhost", "ip6-loopback"]);

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // TEST-NET-2
    (a === 203 && b === 0) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number) as [number, number, number, number];
  return parts.every((n) => n <= 255) ? parts : null;
}

function ipv6Private(raw: string): boolean {
  const h = raw.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped / -compatible (::ffff:127.0.0.1, ::ffff:7f00:1, ::127.0.0.1): judge the embedded IPv4.
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]!);
    return v4 ? ipv4Private(v4[0], v4[1]) : true;
  }
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    return ipv4Private(hi >> 8, hi & 0xff);
  }
  if (h.startsWith("::ffff:")) return true;
  const first = Number.parseInt(h.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (first & 0xff00) === 0xff00 || // multicast
    h.startsWith("64:ff9b:") || // NAT64 may reach private IPv4
    h.startsWith("2001:db8:") || // documentation
    h.startsWith("100::") // discard
  );
}

/** The reason a hostname is refused, or null when it looks public. */
export function blockedHostReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "the URL has no host";
  if (host.startsWith("[") && host.endsWith("]")) return ipv6Private(host.slice(1, -1)) ? "it points to a private or local network address" : null;
  const v4 = parseIpv4(host);
  if (v4) return ipv4Private(v4[0], v4[1]) ? "it points to a private or local network address" : null;
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return "it points to a local or internal host name";
  if (!host.includes(".")) return "it is not a public host name (no domain)";
  return null;
}

/** Parses and checks a URL the model asked for. Throws BlockedUrlError with a reason the model can relay. */
export function checkPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BlockedUrlError("That is not a valid URL. Give a full address starting with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedUrlError(`Only http and https pages can be opened, not ${url.protocol.replace(":", "")}.`);
  if (url.username || url.password) throw new BlockedUrlError("URLs with a username or password in them are not opened.");
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) throw new BlockedUrlError(`Port ${url.port} is not allowed; only standard web ports are.`);
  const reason = blockedHostReason(url.hostname);
  if (reason) throw new BlockedUrlError(`This address is not opened because ${reason}.`);
  url.hash = "";
  return url;
}
