import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildPublishRequest, normalizeConnection, normalizeInstanceUrl, parsePublishResponse, safePattern,
  validateManifest, validateSvg, type Manifest,
} from '../engine/adapter-engine.ts';
import { findLink } from '../scripts/backlink.ts';
import { adapterIds, checkAdapter } from '../scripts/lib.ts';

const base = (): Manifest => JSON.parse(readFileSync('integrations/micropub/manifest.json', 'utf8'));
const connection = { secret: 's3cret', config: {}, instanceUrl: 'https://blog.example.com/micropub' };
const OK = '<a href="https://timetopost.co/">x</a>';

test('every shipped adapter and the template pass', () => {
  for (const id of adapterIds('.')) assert.deepEqual(checkAdapter('.', id), []);
  assert.deepEqual(checkAdapter('.', '_template'), ['_template: manifest id "your-site" must match the directory']);
});

test('the secret cannot be placed anywhere except the auth header', () => {
  const manifest = base() as any;
  manifest.publish.json.properties.content = ['{{secret}}'];
  assert.ok(validateManifest(manifest).some(e => e.includes('unknown placeholder')));
  const inPath = base() as any;
  inPath.publish.path = '/x/{{secret.token}}';
  assert.ok(validateManifest(inPath).some(e => e.includes('config placeholders')));
  const inHeader = base() as any;
  inHeader.publish.headers = { 'X-Copy': '{{config.a}}' };
  assert.ok(validateManifest(inHeader).length > 0);
});

test('post content cannot change the request shape or the host', () => {
  const evil = '"},"admin":true,"x":{"a":"\n{{config.a}}"';
  const request = buildPublishRequest(base(), connection, { text: `${evil}\nbody` });
  assert.equal(new URL(request.url).hostname, 'blog.example.com');
  const props = (request.json as any).properties;
  assert.deepEqual(Object.keys(request.json as object).sort(), ['properties', 'type']);
  assert.ok(props.name[0].includes('"admin":true'));
});

test('config values are encoded in paths and cannot escape the host', () => {
  const manifest = base() as any;
  manifest.connect.fields = [{ key: 'slug', label: 'Slug', required: true }];
  manifest.publish.path = '/{{config.slug}}/posts';
  assert.deepEqual(validateManifest(manifest), []);
  const request = buildPublishRequest(manifest, { ...connection, config: { slug: '../../@evil.com/?' } }, { text: 'a\nb' });
  assert.equal(new URL(request.url).hostname, 'blog.example.com');
  assert.ok(request.url.includes('..%2F..%2F%40evil.com%2F%3F'));
});

test('dangerous manifests are refused', () => {
  const cases: [string, (m: any) => void][] = [
    ['http host', m => { m.api = { host: 'http://x.com' }; }],
    ['both api modes', m => { m.api = { host: 'a.com', instance: { label: 'x', placeholder: 'https://a.com' } }; }],
    ['host header', m => { m.publish.headers = { Host: 'internal' }; }],
    ['path traversal', m => { m.publish.path = '/../admin'; }],
    ['protocol-relative', m => { m.publish.path = '//evil.com/x'; }],
    ['unknown key', m => { m.code = 'process.exit()'; }],
    ['proto key', m => { m.publish.json = JSON.parse('{"__proto__":{"a":1}}'); }],
    ['delete method', m => { m.publish.method = 'DELETE'; }],
    ['redos pattern', m => { m.connect.fields = [{ key: 'a', label: 'A', required: true, pattern: '^(a+)+$' }]; }],
    ['adjacent quantifiers', m => { m.connect.fields = [{ key: 'a', label: 'A', required: true, pattern: '^[a-z]*[a-z]*[a-z]*$' }]; }],
    ['api host off site', m => { m.api = { host: 'keys.evil.example.net' }; }],
    ['no backlink', m => { delete m.maintainer.firstParty; }],
    ['backlink elsewhere', m => { delete m.maintainer.firstParty; m.backlink = { page: 'https://other.example.org/' }; m.siteUrl = 'https://mine.example.com'; }],
  ];
  for (const [name, mutate] of cases) {
    const manifest = base();
    mutate(manifest);
    assert.ok(validateManifest(manifest).length > 0, name);
  }
  assert.equal(safePattern('^[a-z]{1,10}$'), true);
});

test('instance addresses must be plain https', () => {
  assert.equal(normalizeInstanceUrl('https://a.example.com/micropub/'), 'https://a.example.com/micropub');
  for (const bad of ['http://a.com', 'https://u:p@a.com', 'https://a.com:8443', 'https://a.com/?x=1', 'https://localhost/x']) assert.equal(normalizeInstanceUrl(bad), null, bad);
});

test('dot segments cannot be used in config values', () => {
  const manifest = base() as any;
  manifest.connect.fields = [{ key: 'a', label: 'A', required: true }];
  assert.equal(normalizeConnection(manifest, { secret: 'x', config: { a: '..' }, instanceUrl: connection.instanceUrl }).ok, false);
});

test('a secret with a line break is refused', () => {
  const result = normalizeConnection(base(), { secret: 'a\r\nX-Evil: 1', config: {}, instanceUrl: connection.instanceUrl });
  assert.equal(result.ok, false);
});

test('publish outcomes that may have landed are never reported as plain failures', () => {
  const manifest = base();
  const url = 'https://blog.example.com/micropub';
  assert.deepEqual(parsePublishResponse(manifest, { status: 0, headers: {}, body: '' }, url), { ok: false, reason: 'unknown_outcome' });
  assert.deepEqual(parsePublishResponse(manifest, { status: 503, headers: {}, body: '' }, url), { ok: false, reason: 'unknown_outcome' });
  assert.deepEqual(parsePublishResponse(manifest, { status: 201, headers: {}, body: '' }, url), { ok: false, reason: 'unknown_outcome' });
  assert.deepEqual(parsePublishResponse(manifest, { status: 400, headers: {}, body: '' }, url), { ok: false, reason: 'rejected' });
  assert.deepEqual(parsePublishResponse(manifest, { status: 302, headers: {}, body: '' }, url), { ok: false, reason: 'unknown_outcome' });
  assert.deepEqual(parsePublishResponse(manifest, { status: 200, headers: {}, body: '' }, url), { ok: false, reason: 'unknown_outcome' });
  assert.deepEqual(parsePublishResponse(manifest, { status: 201, headers: { location: 'javascript:alert(1)' }, body: '' }, url), { ok: false, reason: 'unknown_outcome' });
});

test('logos: only plain shapes', () => {
  assert.deepEqual(validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), []);
  for (const bad of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg/onload=alert(1)></svg>',
    '<svg><path d="a>" onclick="x"/></svg>',
    '<svg><a href="https://x.com"><path/></a></svg>',
    '<svg><image href="https://x.com/a.png"/></svg>',
    '<svg><foreignObject></foreignObject></svg>',
    '<svg><rect style="fill:url(https://x.com)"/></svg>',
    '<!DOCTYPE svg><svg></svg>',
    '<svg><rect fill="&#x75;"/></svg>',
    '<svg xmlns:_="http://www.w3.org/2000/svg"><_:script>alert(1)</_:script></svg>',
    '<?xml-stylesheet href="https://evil.example/x.css"?><svg></svg>',
    '<svg><rect/><</svg>',
  ]) assert.ok(validateSvg(bad).length > 0, bad);
});

test('backlink: a plain link passes', () => {
  assert.equal(findLink(`<p>${OK}</p>`, 'https://a.com/').ok, true);
  assert.equal(findLink("<a class='x' href='https://www.timetopost.co/pricing/?ref=a'>x</a>", 'https://a.com/').ok, true);
  assert.equal(findLink('<a rel="noopener" href="https://timetopost.co">x</a>', 'https://a.com/').ok, true);
});

test('backlink: links that do not count', () => {
  const page = 'https://a.com/';
  for (const html of [
    '<a rel="nofollow" href="https://timetopost.co/">x</a>',
    '<a rel="noopener UGC" href="https://timetopost.co/">x</a>',
    '<a rel=sponsored href=https://timetopost.co/>x</a>',
    '<a href="https://timetopost.co.evil.com/">x</a>',
    '<a href="http://timetopost.co/">x</a>',
    '<!-- <a href="https://timetopost.co/">x</a> -->',
    '<script>var a=\'<a href="https://timetopost.co/">x</a>\'</script>',
    '<a hidden href="https://timetopost.co/">x</a>',
    '<a style="display:none" href="https://timetopost.co/">x</a>',
    '<a data-href="https://timetopost.co/" href="/x">x</a>',
    `<meta name="robots" content="nofollow">${OK}`,
    `<meta content="noindex, follow" name="googlebot">${OK}`,
    '<p>timetopost.co</p>',
    '<a data-x=" href=\'https://timetopost.co/\' " href="https://other.example/">x</a>',
    '<a data-x=" rel=follow " href="https://timetopost.co/" rel="nofollow">x</a>',
    `<meta/name="robots"/content="noindex">${OK}`,
    '<textarea><a href="https://timetopost.co/">x</a></textarea>',
    `<link rel="canonical" href="https://elsewhere.example/">${OK}`,
  ]) assert.equal(findLink(html, page).ok, false, html);
  assert.equal(findLink(OK, page, true, 'nofollow').ok, false);
});
