import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sameSite } from '../engine/adapter-engine.ts';

/** The listing rule. Set to false to accept rel="nofollow", "ugc" or "sponsored" links too. */
export const REQUIRE_DOFOLLOW = true;
export const TARGET_HOSTS = new Set(['timetopost.co', 'www.timetopost.co']);
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const TAG = '(?:"[^"]*"|\'[^\']*\'|[^\'">])*';

// Walks attributes the way an HTML tokenizer does, so quoted text cannot pose as an attribute.
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  let i = /^<[a-zA-Z][^\s/>]*/.exec(tag)?.[0].length ?? 1;
  while (i < tag.length) {
    while (i < tag.length && /[\s/]/.test(tag[i])) i++;
    if (i >= tag.length || tag[i] === '>') break;
    const start = i;
    while (i < tag.length && !/[\s/>=]/.test(tag[i])) i++;
    const name = tag.slice(start, i).toLowerCase();
    if (i === start) { i++; continue; }
    while (i < tag.length && /\s/.test(tag[i])) i++;
    let value = '';
    if (tag[i] === '=') {
      i++;
      while (i < tag.length && /\s/.test(tag[i])) i++;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, i + 1);
        value = tag.slice(i + 1, end === -1 ? tag.length : end);
        i = end === -1 ? tag.length : end + 1;
      } else {
        const valueStart = i;
        while (i < tag.length && !/[\s>]/.test(tag[i])) i++;
        value = tag.slice(valueStart, i);
      }
    }
    if (!found.has(name)) found.set(name, value);
  }
  return found;
}

export type LinkVerdict = { ok: true; href: string } | { ok: false; reason: string };

/** Looks only at server-rendered HTML, the same document a crawler gets first. */
export function findLink(html: string, pageUrl: string, requireDofollow = REQUIRE_DOFOLLOW, robotsHeader = ''): LinkVerdict {
  const visible = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|textarea|title|xmp|noembed|noframes|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  if (/\b(noindex|none)\b/i.test(robotsHeader)) return { ok: false, reason: 'the page sends X-Robots-Tag noindex' };
  if (requireDofollow && /\bnofollow\b/i.test(robotsHeader)) return { ok: false, reason: 'the page sends X-Robots-Tag nofollow' };
  for (const match of visible.matchAll(new RegExp(`<meta\\b${TAG}>`, 'gi'))) {
    const meta = attributes(match[0]);
    const name = meta.get('name')?.toLowerCase();
    if (name !== 'robots' && name !== 'googlebot') continue;
    const content = meta.get('content') ?? '';
    if (/\b(noindex|none)\b/i.test(content)) return { ok: false, reason: 'the page is marked noindex' };
    if (requireDofollow && /\bnofollow\b/i.test(content)) return { ok: false, reason: 'the page is marked nofollow' };
  }
  for (const match of visible.matchAll(new RegExp(`<link\\b${TAG}>`, 'gi'))) {
    const link = attributes(match[0]);
    if (!(link.get('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) continue;
    try {
      if (!sameSite(new URL(link.get('href') ?? '', pageUrl).hostname, new URL(pageUrl).hostname)) return { ok: false, reason: 'the page declares a canonical URL on another site' };
    } catch { return { ok: false, reason: 'the page has an invalid canonical URL' }; }
  }
  let qualified = false;
  let hidden = false;
  for (const match of visible.matchAll(new RegExp(`<a\\b${TAG}>`, 'gi'))) {
    const anchor = attributes(match[0]);
    const href = anchor.get('href');
    if (!href) continue;
    let target: URL;
    try { target = new URL(href.trim(), pageUrl); } catch { continue; }
    if (target.protocol !== 'https:' || !TARGET_HOSTS.has(target.hostname.toLowerCase())) continue;
    if (anchor.has('hidden') || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(anchor.get('style') ?? '')) { hidden = true; continue; }
    const rel = (anchor.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (requireDofollow && rel.some(token => ['nofollow', 'ugc', 'sponsored'].includes(token))) { qualified = true; continue; }
    return { ok: true, href: target.toString() };
  }
  if (qualified) return { ok: false, reason: 'the link to timetopost.co has rel nofollow, ugc or sponsored' };
  if (hidden) return { ok: false, reason: 'the link to timetopost.co is hidden' };
  return { ok: false, reason: 'no <a href="https://timetopost.co..."> link in the server-rendered HTML' };
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return privateAddress(mapped[1]);
    return lower === '::1' || lower === '::' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'https:' || url.port) throw new Error('only https on the default port is checked');
  const records = await lookup(url.hostname, { all: true });
  if (!records.length || records.some(record => privateAddress(record.address))) throw new Error('the host does not resolve to a public address');
}

/** Fetches a manifest's page. The URL is untrusted input from a pull request. */
export async function checkBacklink(page: string, siteUrl: string): Promise<LinkVerdict> {
  let current = new URL(page);
  const siteHost = new URL(siteUrl).hostname;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!sameSite(current.hostname, siteHost)) return { ok: false, reason: `the page redirects off ${siteHost}` };
      await assertPublic(current);
      const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'TimeToPost-Community-Backlink-Check/1.0 (+https://timetopost.co/integrations/community/)', Accept: 'text/html' } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { ok: false, reason: 'a redirect had no Location' };
        current = new URL(location, current);
        continue;
      }
      if (response.status !== 200) return { ok: false, reason: `the page answered HTTP ${response.status}` };
      const reader = response.body?.getReader();
      if (!reader) return { ok: false, reason: 'the page had no body' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel(); return { ok: false, reason: 'the page is over 3 MB' }; }
        chunks.push(value);
      }
      return findLink(Buffer.concat(chunks).toString('utf8'), current.toString(), REQUIRE_DOFOLLOW, response.headers.get('x-robots-tag') ?? '');
    }
    return { ok: false, reason: 'too many redirects' };
  } catch (error) {
    return { ok: false, reason: `could not fetch the page: ${(error as Error).message}` };
  }
}
