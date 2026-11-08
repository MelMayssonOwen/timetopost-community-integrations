import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPublishRequest, buildVerifyRequest, normalizeConnection, parsePublishResponse, parseVerifyResponse,
  validateManifest, validatePost, validateSvg, type ConnectionInput, type Manifest, type WireResponse,
} from '../engine/adapter-engine.ts';

export const ALLOWED_FILES = new Set(['manifest.json', 'tests.json', 'logo.svg']);

export interface Fixture {
  name: string;
  action: 'verify' | 'publish';
  input: { secret: string; config: Record<string, string>; instanceUrl?: string; text?: string; tags?: string[] };
  expectRequest?: { method: string; url: string; headers?: Record<string, string>; json?: unknown };
  response: { status: number; headers?: Record<string, string>; body?: unknown };
  expectResult: Record<string, unknown>;
}

// PR content is read as data. A symlink could point the reader at a runner file.
function readData(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`${path} must be a regular file`);
  return readFileSync(path, 'utf8');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((key, i) => key === bk[i] && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

export function runFixture(manifest: Manifest, fixture: Fixture): string[] {
  const errors: string[] = [];
  const prefix = `test "${fixture.name}":`;
  const normalized = normalizeConnection(manifest, fixture.input);
  if (!normalized.ok) return [`${prefix} ${normalized.error}`];
  const connection: ConnectionInput = normalized.connection;
  const post = { text: fixture.input.text ?? '', tags: fixture.input.tags };
  if (fixture.action === 'publish') {
    const problem = validatePost(manifest, post);
    if (problem) return [`${prefix} ${problem}`];
  }
  const request = fixture.action === 'verify' ? buildVerifyRequest(manifest, connection) : buildPublishRequest(manifest, connection, post);
  const expected = fixture.expectRequest;
  if (expected) {
    if (expected.method !== request.method) errors.push(`${prefix} method ${request.method}, expected ${expected.method}`);
    if (expected.url !== request.url) errors.push(`${prefix} url ${request.url}, expected ${expected.url}`);
    for (const [key, value] of Object.entries(expected.headers ?? {})) if (request.headers[key] !== value) errors.push(`${prefix} header ${key} did not match`);
    if ('json' in expected && !deepEqual(request.json, expected.json)) errors.push(`${prefix} body ${JSON.stringify(request.json)}, expected ${JSON.stringify(expected.json)}`);
  }
  const body = fixture.response.body === undefined ? '' : JSON.stringify(fixture.response.body);
  const response: WireResponse = { status: fixture.response.status, headers: fixture.response.headers ?? {}, body };
  const parsed = fixture.action === 'verify' ? parseVerifyResponse(manifest, response) : parsePublishResponse(manifest, response, request.url);
  if (!deepEqual(JSON.parse(JSON.stringify(parsed)), fixture.expectResult)) errors.push(`${prefix} result ${JSON.stringify(parsed)}, expected ${JSON.stringify(fixture.expectResult)}`);
  return errors;
}

export function loadManifest(root: string, id: string): Manifest {
  return JSON.parse(readData(join(root, 'integrations', id, 'manifest.json'))) as Manifest;
}

/** All data-level rules for one adapter directory. Runs no contributor code. */
export function checkAdapter(root: string, id: string): string[] {
  const directory = join(root, 'integrations', id);
  const errors: string[] = [];
  const names = readdirSync(directory);
  for (const name of names) if (!ALLOWED_FILES.has(name)) errors.push(`${id}/${name} is not an allowed file`);
  for (const name of ALLOWED_FILES) if (!names.includes(name)) errors.push(`${id}/${name} is missing`);
  if (errors.length) return errors;

  let manifest: Manifest;
  let fixtures: Fixture[];
  try {
    manifest = JSON.parse(readData(join(directory, 'manifest.json')));
    fixtures = JSON.parse(readData(join(directory, 'tests.json')));
    errors.push(...validateSvg(readData(join(directory, 'logo.svg'))));
  } catch (error) { return [...errors, `${id}: ${(error as Error).message}`]; }

  const problems = validateManifest(manifest);
  if (problems.length) return [...errors, ...problems.map(problem => `${id}: ${problem}`)];
  if (manifest.id !== id) errors.push(`${id}: manifest id "${manifest.id}" must match the directory`);
  if (!Array.isArray(fixtures)) return [...errors, `${id}: tests.json must be a list`];
  for (const action of ['verify', 'publish'] as const) {
    if (!fixtures.some(f => f.action === action && f.expectRequest && f.expectResult?.ok === true)) errors.push(`${id}: tests.json needs a successful ${action} test with expectRequest`);
  }
  for (const fixture of fixtures) {
    try { errors.push(...runFixture(manifest, fixture).map(problem => `${id}: ${problem}`)); }
    catch (error) { errors.push(`${id}: test "${fixture?.name}" threw: ${(error as Error).message}`); }
  }
  return errors;
}

export function adapterIds(root: string): string[] {
  return readdirSync(join(root, 'integrations'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .map(entry => entry.name).sort();
}
