// Declarative adapter engine. Zero dependencies, erasable TypeScript only.
// TimeToPost vendors this exact file, so CI and production run the same rules.
// An adapter is data: it can describe one HTTPS request, never run code.

export const SCHEMA_VERSION = 1;
export const CATEGORIES = ['blog', 'community', 'newsletter', 'social', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  json?: JsonValue;
  headers?: Record<string, string>;
  /** Successful HTTP statuses. Defaults to [200, 201]. */
  status?: number[];
  /** Dot path in the JSON response. A truthy value there means the request was rejected. */
  errorPath?: string;
}

export interface Field {
  key: string;
  label: string;
  help?: string;
  required: boolean;
  pattern?: string;
}

export interface Manifest {
  schemaVersion: 1;
  id: string;
  name: string;
  tagline: string;
  siteUrl: string;
  category: Category;
  maintainer: { github: string; firstParty?: boolean };
  backlink?: { page: string };
  content: { format: 'article' | 'text'; maxChars: number };
  api: { host: string } | { instance: { label: string; placeholder: string } };
  connect: { secret: { label: string; help: string; helpUrl?: string }; fields: Field[] };
  auth: { header: string; prefix: string };
  verify: RequestSpec & { result?: { accountId?: string; accountName?: string } };
  publish: RequestSpec & { result: { postId?: string; url?: string; urlHeader?: string } };
}

export interface ConnectionInput {
  secret: string;
  config: Record<string, string>;
  /** Normalized base URL, required for self-hosted adapters. */
  instanceUrl?: string;
}

export interface PostInput {
  text: string;
  tags?: string[];
}

export interface BuiltRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  json?: JsonValue;
}

export interface WireResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export type ParsedVerify =
  | { ok: true; accountId?: string; accountName?: string }
  | { ok: false; reason: 'auth' | 'rate_limited' | 'rejected' | 'unavailable' };

export type ParsedPublish =
  | { ok: true; postId?: string; url?: string }
  | { ok: false; reason: 'auth' | 'rate_limited' | 'rejected' | 'unknown_outcome' };

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const DOT_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;
const GITHUB_USER = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const POST_PLACEHOLDERS = new Set(['post.text', 'post.title', 'post.body', 'post.tags']);
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'set-cookie', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'proxy-authorization', 'forwarded', 'origin', 'referer']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MANIFEST_KEYS = new Set(['schemaVersion', 'id', 'name', 'tagline', 'siteUrl', 'category', 'maintainer', 'backlink', 'content', 'api', 'connect', 'auth', 'verify', 'publish']);
const REQUEST_KEYS = new Set(['method', 'path', 'json', 'headers', 'status', 'errorPath', 'result']);
const MAX_JSON_NODES = 200;
const MAX_REGEX_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url;
  } catch { return null; }
}

/** A user-supplied pattern must not be able to hang the server (no nested quantifiers, no backreferences). */
export function safePattern(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string' || pattern.length > MAX_REGEX_LENGTH || !pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  if (/\\[1-9]|\(\?[=!<]/.test(pattern)) return false;
  // Any group that is itself quantified is refused: the classic catastrophic shape.
  if (/\)\s*[*+?{]/.test(pattern)) return false;
  // Adjacent variable quantifiers backtrack combinatorially. Two stay polynomial on a 500 character value.
  if ((pattern.match(/[*+?]|\{\d+,\d*\}/g)?.length ?? 0) > 2) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map(match => match[1]);
}

function walkStrings(value: unknown, visit: (s: string) => void, keys: (k: string) => void, budget = { left: MAX_JSON_NODES }): void {
  if (--budget.left < 0) throw new Error('json template is too large');
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(item => walkStrings(item, visit, keys, budget));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) { keys(key); walkStrings(item, visit, keys, budget); }
}

function requestErrors(spec: unknown, name: 'verify' | 'publish', fields: Set<string>, add: (m: string) => void): void {
  if (!isRecord(spec)) { add(`${name} must be an object`); return; }
  for (const key of Object.keys(spec)) if (!REQUEST_KEYS.has(key)) add(`${name}.${key} is not a known key`);
  const allowed = name === 'publish' ? ['POST', 'PUT'] : ['GET', 'POST'];
  if (!allowed.includes(spec.method as string)) add(`${name}.method must be one of ${allowed.join(', ')}`);
  if (typeof spec.path !== 'string' || spec.path.length > 300 || !/^(|[/?][^\s#]*)$/.test(spec.path) || spec.path.includes('..') || spec.path.includes('//') || spec.path.includes('\\')) {
    add(`${name}.path must be empty or start with / or ?, without .. or //`);
  } else {
    for (const token of placeholders(spec.path)) {
      if (!token.startsWith('config.') || !fields.has(token.slice(7))) add(`${name}.path may only use config placeholders, found ${token}`);
    }
  }
  const checkPlaceholders = (where: string, allowPost: boolean) => (value: string) => {
    for (const token of placeholders(value)) {
      const known = (token.startsWith('config.') && fields.has(token.slice(7))) || (allowPost && POST_PLACEHOLDERS.has(token));
      if (!known) add(`${where} uses unknown placeholder {{${token}}}`);
    }
  };
  if (spec.method === 'GET' && spec.json !== undefined) add(`${name}: a GET request cannot have a json body`);
  if (spec.json !== undefined) {
    try {
      walkStrings(spec.json, checkPlaceholders(`${name}.json`, name === 'publish'), key => {
        if (FORBIDDEN_KEYS.has(key)) add(`${name}.json has a forbidden key ${key}`);
      });
    } catch (error) { add(`${name}.json: ${(error as Error).message}`); }
  }
  if (spec.headers !== undefined) {
    if (!isRecord(spec.headers)) add(`${name}.headers must be an object`);
    else for (const [header, value] of Object.entries(spec.headers)) {
      if (!HEADER_NAME.test(header) || FORBIDDEN_HEADERS.has(header.toLowerCase()) || header.toLowerCase().startsWith('x-forwarded') || header.toLowerCase() === 'authorization') add(`${name}.headers.${header} is not allowed`);
      if (!text(value, 300)) add(`${name}.headers.${header} must be short plain text`);
      else if (placeholders(value).length > 0) add(`${name}.headers.${header} cannot use placeholders`);
    }
  }
  if (spec.status !== undefined && (!Array.isArray(spec.status) || spec.status.length === 0 || spec.status.some(code => !Number.isInteger(code) || code < 200 || code > 299))) add(`${name}.status must be a list of 2xx codes`);
  if (spec.errorPath !== undefined && (typeof spec.errorPath !== 'string' || !DOT_PATH.test(spec.errorPath))) add(`${name}.errorPath must be a dot path`);
  const result = spec.result;
  if (name === 'publish') {
    if (!isRecord(result)) { add('publish.result must be an object'); return; }
    if (!result.postId && !result.url && !result.urlHeader) add('publish.result needs postId, url or urlHeader');
    for (const key of Object.keys(result)) if (!['postId', 'url', 'urlHeader'].includes(key)) add(`publish.result.${key} is not a known key`);
    for (const key of ['postId', 'url'] as const) if (result[key] !== undefined && (typeof result[key] !== 'string' || !DOT_PATH.test(result[key] as string))) add(`publish.result.${key} must be a dot path`);
    if (result.urlHeader !== undefined && (typeof result.urlHeader !== 'string' || !HEADER_NAME.test(result.urlHeader))) add('publish.result.urlHeader must be a header name');
  } else if (result !== undefined) {
    if (!isRecord(result)) { add('verify.result must be an object'); return; }
    for (const key of Object.keys(result)) if (!['accountId', 'accountName'].includes(key)) add(`verify.result.${key} is not a known key`);
    for (const key of ['accountId', 'accountName'] as const) if (result[key] !== undefined && (typeof result[key] !== 'string' || !DOT_PATH.test(result[key] as string))) add(`verify.result.${key} must be a dot path`);
  }
}

/** Every rule a manifest must pass. Returns human-readable problems; empty means valid. */
export function validateManifest(input: unknown): string[] {
  const errors: string[] = [];
  const add = (message: string) => { errors.push(message); };
  if (!isRecord(input)) return ['manifest must be a JSON object'];
  for (const key of Object.keys(input)) if (!MANIFEST_KEYS.has(key)) add(`${key} is not a known key`);
  if (input.schemaVersion !== SCHEMA_VERSION) add(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (typeof input.id !== 'string' || !ID.test(input.id)) add('id must be 2 to 40 lowercase letters, digits or hyphens');
  if (!text(input.name, 40)) add('name must be 1 to 40 characters');
  if (!text(input.tagline, 120)) add('tagline must be 1 to 120 characters');
  const site = httpsUrl(input.siteUrl);
  if (!site) add('siteUrl must be an https URL without a port or credentials');
  if (!CATEGORIES.includes(input.category as Category)) add(`category must be one of ${CATEGORIES.join(', ')}`);

  const maintainer = input.maintainer;
  const firstParty = isRecord(maintainer) && maintainer.firstParty === true;
  if (!isRecord(maintainer) || typeof maintainer.github !== 'string' || !GITHUB_USER.test(maintainer.github)) add('maintainer.github must be a GitHub username');
  if (isRecord(maintainer) && maintainer.firstParty !== undefined && typeof maintainer.firstParty !== 'boolean') add('maintainer.firstParty must be true or absent');
  if (isRecord(maintainer)) for (const key of Object.keys(maintainer)) if (!['github', 'firstParty'].includes(key)) add(`maintainer.${key} is not a known key`);

  const backlink = input.backlink;
  if (backlink === undefined) { if (!firstParty) add('backlink.page is required'); }
  else if (!isRecord(backlink) || !httpsUrl(backlink.page)) add('backlink.page must be an https URL');
  else if (site && !sameSite(new URL(backlink.page as string).hostname, site.hostname)) add('backlink.page must be on the same site as siteUrl');

  const content = input.content;
  if (!isRecord(content) || !['article', 'text'].includes(content.format as string)) add('content.format must be article or text');
  if (!isRecord(content) || !Number.isInteger(content.maxChars) || (content.maxChars as number) < 1 || (content.maxChars as number) > 200_000) add('content.maxChars must be between 1 and 200000');

  const api = input.api;
  if (!isRecord(api) || ('host' in api) === ('instance' in api)) add('api must have exactly one of host or instance');
  else if ('host' in api) {
    if (typeof api.host !== 'string' || !HOST.test(api.host)) add('api.host must be a lowercase public hostname');
    else if (site && !sameSite(api.host, site.hostname)) add('api.host must be on the same site as siteUrl');
  } else if (!isRecord(api.instance) || !text(api.instance.label, 60) || !httpsUrl(api.instance.placeholder)) add('api.instance needs a label and an https placeholder');

  const fieldKeys = new Set<string>();
  const connect = input.connect;
  if (!isRecord(connect) || !isRecord(connect.secret) || !text(connect.secret.label, 60) || !text(connect.secret.help, 300)) add('connect.secret needs a label and help text');
  else if (connect.secret.helpUrl !== undefined && !httpsUrl(connect.secret.helpUrl)) add('connect.secret.helpUrl must be an https URL');
  if (!isRecord(connect) || !Array.isArray(connect.fields) || connect.fields.length > 6) add('connect.fields must be a list of at most 6 fields');
  else connect.fields.forEach((field: unknown, index: number) => {
    if (!isRecord(field) || typeof field.key !== 'string' || !FIELD_KEY.test(field.key) || FORBIDDEN_KEYS.has(field.key)) { add(`connect.fields[${index}].key is invalid`); return; }
    if (fieldKeys.has(field.key)) add(`connect.fields has a duplicate key ${field.key}`);
    fieldKeys.add(field.key);
    if (!text(field.label, 60)) add(`connect.fields[${index}].label is required`);
    if (field.help !== undefined && !text(field.help, 300)) add(`connect.fields[${index}].help is too long`);
    if (typeof field.required !== 'boolean') add(`connect.fields[${index}].required must be true or false`);
    if (field.pattern !== undefined && !safePattern(field.pattern)) add(`connect.fields[${index}].pattern must be anchored and free of nested quantifiers`);
  });

  const auth = input.auth;
  if (!isRecord(auth) || typeof auth.header !== 'string' || !HEADER_NAME.test(auth.header) || FORBIDDEN_HEADERS.has(auth.header.toLowerCase())) add('auth.header must be a safe header name');
  if (!isRecord(auth) || typeof auth.prefix !== 'string' || auth.prefix.length > 40 || /[\r\n]/.test(auth.prefix)) add('auth.prefix must be a short string, possibly empty');

  requestErrors(input.verify, 'verify', fieldKeys, add);
  requestErrors(input.publish, 'publish', fieldKeys, add);
  return errors;
}

export function sameSite(host: string, siteHost: string): boolean {
  const strip = (value: string) => value.toLowerCase().replace(/^www\./, '');
  const a = strip(host);
  const b = strip(siteHost);
  return a === b || a.endsWith(`.${b}`);
}

/** Validates what a user typed against the manifest. Returns the clean config. */
export function normalizeConnection(manifest: Manifest, input: { secret: unknown; config: unknown; instanceUrl?: unknown }): { ok: true; connection: ConnectionInput } | { ok: false; error: string } {
  if (typeof input.secret !== 'string' || !input.secret.trim() || input.secret.length > 4096 || /[\r\n]/.test(input.secret)) return { ok: false, error: `Enter a valid ${manifest.connect.secret.label}.` };
  const raw = isRecord(input.config) ? input.config : {};
  const config: Record<string, string> = {};
  for (const field of manifest.connect.fields) {
    const value = typeof raw[field.key] === 'string' ? (raw[field.key] as string).trim() : '';
    if (!value) { if (field.required) return { ok: false, error: `${field.label} is required.` }; continue; }
    if (value === '.' || value === '..' || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value) || (field.pattern && !new RegExp(field.pattern).test(value))) return { ok: false, error: `${field.label} is not valid.` };
    config[field.key] = value;
  }
  const connection: ConnectionInput = { secret: input.secret.trim(), config };
  if ('instance' in manifest.api) {
    const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
    if (!instanceUrl) return { ok: false, error: 'Enter the https address of your site, without a port, query or credentials.' };
    connection.instanceUrl = instanceUrl;
  }
  return { ok: true, connection };
}

export function normalizeInstanceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = httpsUrl(value.trim());
  if (!url || url.search || url.hash || !url.hostname.includes('.') || url.pathname.includes('..')) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** First line is the title, the rest is the body, as for other article networks. */
export function splitPost(input: PostInput): { text: string; title: string; body: string; tags: string[] } {
  const full = (input.text || '').trim();
  const [first, ...rest] = full.split(/\r?\n/);
  return { text: full, title: (first || '').replace(/^#{1,6}\s+/, '').trim(), body: rest.join('\n').trim(), tags: input.tags ?? [] };
}

export function validatePost(manifest: Manifest, input: PostInput): string | null {
  const post = splitPost(input);
  if (!post.text) return `${manifest.name} needs some text.`;
  if (post.text.length > manifest.content.maxChars) return `${manifest.name} accepts up to ${manifest.content.maxChars} characters.`;
  if (manifest.content.format === 'article') {
    if (!post.title || post.title.length > 250) return `${manifest.name} needs a title of 1 to 250 characters on the first line.`;
    if (!post.body) return `Write the ${manifest.name} article body below the title.`;
  }
  return null;
}

type Values = Record<string, string | string[]>;

function fill(value: string, values: Values, encode: boolean): string {
  return value.replace(PLACEHOLDER, (_all, token: string) => {
    const resolved = values[token];
    const flat = Array.isArray(resolved) ? resolved.join(',') : resolved ?? '';
    return encode ? encodeURIComponent(flat) : flat;
  });
}

// Values are placed into the parsed tree, never spliced into JSON text, so post
// content cannot change the shape of the request.
function render(template: JsonValue, values: Values): JsonValue | undefined {
  if (typeof template === 'string') {
    const only = /^\{\{\s*([^{}]*?)\s*\}\}$/.exec(template);
    if (only) {
      const resolved = values[only[1]];
      if (resolved === undefined || resolved === '' || (Array.isArray(resolved) && resolved.length === 0)) return undefined;
      return resolved;
    }
    return fill(template, values, false);
  }
  if (Array.isArray(template)) {
    const items = template.map(item => render(item, values)).filter((item): item is JsonValue => item !== undefined);
    return items.length === 0 && template.length > 0 ? undefined : items;
  }
  if (template !== null && typeof template === 'object') {
    const out: Record<string, JsonValue> = Object.create(null);
    for (const [key, item] of Object.entries(template)) {
      const rendered = render(item, values);
      if (rendered !== undefined) out[key] = rendered;
    }
    return { ...out };
  }
  return template;
}

function baseUrl(manifest: Manifest, connection: ConnectionInput): string {
  if ('host' in manifest.api) return `https://${manifest.api.host}`;
  const normalized = normalizeInstanceUrl(connection.instanceUrl);
  if (!normalized) throw new Error('This connection has no valid site address.');
  return normalized;
}

function build(manifest: Manifest, spec: RequestSpec, connection: ConnectionInput, post?: PostInput): BuiltRequest {
  const values: Values = {};
  for (const [key, value] of Object.entries(connection.config)) values[`config.${key}`] = value;
  if (post) {
    const parts = splitPost(post);
    Object.assign(values, { 'post.text': parts.text, 'post.title': parts.title, 'post.body': parts.body, 'post.tags': parts.tags });
  }
  const base = baseUrl(manifest, connection);
  const url = new URL(`${base}${fill(spec.path, values, true)}`);
  // The host is decided by the manifest or the connection, never by a placeholder.
  if (url.origin !== new URL(base).origin || url.protocol !== 'https:') throw new Error('Refused a request outside the adapter host.');
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  headers[manifest.auth.header] = `${manifest.auth.prefix}${connection.secret}`;
  const built: BuiltRequest = { method: spec.method, url: url.toString(), headers };
  if (spec.json !== undefined) {
    built.json = render(spec.json, values) ?? {};
    headers['Content-Type'] = 'application/json';
  }
  headers.Accept = headers.Accept ?? 'application/json';
  return built;
}

export const buildVerifyRequest = (manifest: Manifest, connection: ConnectionInput): BuiltRequest => build(manifest, manifest.verify, connection);
export const buildPublishRequest = (manifest: Manifest, connection: ConnectionInput, post: PostInput): BuiltRequest => build(manifest, manifest.publish, connection, post);

function read(root: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(part)) { current = current[Number(part)]; continue; }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return undefined; }
}

function scalar(value: unknown, max = 512): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function safeResultUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch { return undefined; }
}

const statuses = (spec: RequestSpec) => spec.status ?? [200, 201];

export function parseVerifyResponse(manifest: Manifest, response: WireResponse): ParsedVerify {
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'auth' };
  if (response.status === 429) return { ok: false, reason: 'rate_limited' };
  if (!statuses(manifest.verify).includes(response.status)) return { ok: false, reason: response.status >= 500 || response.status === 0 ? 'unavailable' : 'rejected' };
  const json = parseJson(response.body);
  // A verify call answering 200 with an error object means the credential failed.
  if (manifest.verify.errorPath && read(json, manifest.verify.errorPath)) return { ok: false, reason: 'auth' };
  const accountId = scalar(read(json, manifest.verify.result?.accountId));
  const accountName = scalar(read(json, manifest.verify.result?.accountName), 120);
  if (manifest.verify.result?.accountId && !accountId) return { ok: false, reason: 'auth' };
  return { ok: true, accountId, accountName };
}

export function parsePublishResponse(manifest: Manifest, response: WireResponse, requestUrl: string): ParsedPublish {
  // No response or a server error: the post may exist. The caller must not retry.
  if (response.status === 0 || response.status >= 500) return { ok: false, reason: 'unknown_outcome' };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'auth' };
  if (response.status === 429) return { ok: false, reason: 'rate_limited' };
  // Only a 4xx is a definite refusal. A redirect or unlisted 2xx may have created the post.
  if (!statuses(manifest.publish).includes(response.status)) return { ok: false, reason: response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown_outcome' };
  const json = parseJson(response.body);
  if (manifest.publish.errorPath && read(json, manifest.publish.errorPath)) return { ok: false, reason: 'rejected' };
  const result = manifest.publish.result;
  const postId = scalar(read(json, result.postId));
  const headerName = result.urlHeader?.toLowerCase();
  const headerValue = headerName ? Object.entries(response.headers).find(([key]) => key.toLowerCase() === headerName)?.[1] : undefined;
  const url = safeResultUrl(read(json, result.url)) ?? safeResultUrl(headerValue, requestUrl);
  // A 2xx that names no post cannot be told apart from a lost one.
  if (!postId && !url) return { ok: false, reason: 'unknown_outcome' };
  return { ok: true, postId: postId ?? url, url };
}

const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc', 'clippath', 'mask']);
const SVG_MAX_BYTES = 50_000;

/** Logos are served from timetopost.co, so anything not on the allowlist is refused. */
export function validateSvg(svg: string): string[] {
  const errors: string[] = [];
  if (Buffer.byteLength(svg, 'utf8') > SVG_MAX_BYTES) errors.push('logo.svg must be under 50 KB');
  const body = svg.replace(/^\s*<\?xml version="1\.[01]"( encoding="UTF-8")?\?>/i, '');
  if (!/^\s*<svg[\s>]/i.test(body)) errors.push('logo.svg must start with an <svg> element');
  if (/<[!?]|&#|&[a-z]+;/i.test(body)) errors.push('logo.svg cannot contain entities, doctypes, comments or processing instructions');
  // Every "<" must open or close an allowlisted element. Nothing else may contain one.
  for (const match of body.matchAll(/</g)) {
    const name = /^\/?([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/.exec(body.slice(match.index + 1, match.index + 40))?.[1];
    if (!name || !SVG_ELEMENTS.has(name.toLowerCase())) errors.push(`logo.svg cannot use the element at offset ${match.index}`);
  }
  if (/[\s/"']on[a-z]+\s*=/i.test(body)) errors.push('logo.svg cannot use event handler attributes');
  for (const tag of body.matchAll(/<[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>/g)) {
    for (const attr of tag[0].matchAll(/[\s/"']([a-zA-Z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g)) {
      const name = attr[1].toLowerCase();
      const value = attr[2].replace(/^['"]|['"]$/g, '');
      if (name.startsWith('on') || name === 'href' || name.endsWith(':href') || name === 'style' || name === 'src' || name.startsWith('xmlns:')) errors.push(`logo.svg cannot use the ${attr[1]} attribute`);
      if (/url\(\s*(?!['"]?#)/i.test(value) || /javascript:|data:/i.test(value)) errors.push('logo.svg cannot reference external resources');
    }
  }
  return [...new Set(errors)];
}
