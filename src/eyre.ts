import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MINATO_DIR, writeJsonAtomic } from './config.ts';

export type ShipRank = 'galaxy' | 'star' | 'planet' | 'moon' | 'comet' | 'unknown';

/**
 * Rank from the shape of the name alone: galaxies are one short syllable, stars
 * one long, and planets/moons/comets are 2/4/8 hyphenated pairs. Worth knowing
 * client-side because the gen-moon thread refuses to run on a moon or comet,
 * and catching that here saves asking for a password first.
 */
export function shipRank(name: string): ShipRank {
  const parts = name.replace(/^~/, '').split('-');
  if (parts.length === 1) return parts[0].length === 3 ? 'galaxy' : 'star';
  if (parts.length === 2) return 'planet';
  if (parts.length === 4) return 'moon';
  if (parts.length === 8) return 'comet';
  return 'unknown';
}

export interface Endpoint {
  /** Base URL, no trailing slash. */
  url: string;
  /** Ship name without the leading sig, used for the auth cookie name. */
  ship: string;
}

/**
 * Accepts either a full URL or a bare ship name. Self-hosted ships are common
 * enough that the `<ship>.arvo.network` convention cannot be assumed.
 */
export function resolveEndpoint(planet: string, hosted: boolean): Endpoint {
  if (/^https?:\/\//.test(planet)) {
    const url = planet.replace(/\/+$/, '');
    return { url, ship: '' };
  }
  const ship = planet.replace(/^~/, '');
  const domain = hosted ? 'tlon.network' : 'arvo.network';
  return { url: `https://${ship}.${domain}`, ship };
}

interface CachedCookie {
  cookie: string;
  /** Epoch seconds, or 0 for a session cookie. */
  expires: number;
}

const COOKIE_DIR = join(MINATO_DIR, 'cookies');

function cookiePath(url: string): string {
  return join(COOKIE_DIR, `${new URL(url).host.replace(/[^a-z0-9.-]/gi, '_')}.json`);
}

function readCachedCookie(url: string): string | null {
  const path = cookiePath(url);
  if (!existsSync(path)) return null;
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as CachedCookie;
    if (cached.expires && cached.expires <= Math.floor(Date.now() / 1000)) {
      unlinkSync(path);
      return null;
    }
    return cached.cookie;
  } catch {
    return null;
  }
}

function writeCachedCookie(url: string, cookie: string, maxAge: number): void {
  mkdirSync(COOKIE_DIR, { recursive: true, mode: 0o700 });
  const path = cookiePath(url);
  writeJsonAtomic(path, {
    cookie,
    expires: maxAge ? Math.floor(Date.now() / 1000) + maxAge : 0,
  } satisfies CachedCookie);
  chmodSync(path, 0o600);
}

export function forgetCookie(url: string): void {
  const path = cookiePath(url);
  if (existsSync(path)) unlinkSync(path);
}

/** Read a secret from the terminal without echoing it. */
export function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('a password is required but stdin is not a terminal'));
      return;
    }
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const done = (err: Error | null): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(null);
        if (ch === '') return done(new Error('cancelled'));
        if (ch === '' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Log in with the ship's +code and cache the session cookie.
 * The code is sent in a form body, never in argv, and is dropped immediately.
 */
async function login(endpoint: Endpoint): Promise<string> {
  const label = endpoint.ship ? `~${endpoint.ship}` : endpoint.url;
  const code = await readSecret(`+code for ${label}: `);
  if (!code) throw new Error('code cannot be empty');

  const res = await fetch(`${endpoint.url}/~/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(code)}`,
    redirect: 'manual',
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const auth = setCookie.find((c) => c.startsWith('urbauth-'));
  if (!res.ok && !auth) {
    throw new Error(`login failed at ${endpoint.url} (HTTP ${res.status})`);
  }
  if (!auth) throw new Error(`${endpoint.url} returned no urbauth cookie`);

  const cookie = auth.split(';')[0];
  const maxAge = Number(auth.match(/Max-Age=(\d+)/i)?.[1] ?? 0);
  writeCachedCookie(endpoint.url, cookie, maxAge);
  return cookie;
}

async function authCookie(endpoint: Endpoint): Promise<string> {
  return readCachedCookie(endpoint.url) ?? (await login(endpoint));
}

/**
 * Run a Gall thread over Eyre's spider endpoint and return the parsed JSON.
 * A rejected cached cookie is discarded and the login retried once.
 */
export async function runThread<T>(
  endpoint: Endpoint,
  desk: string,
  thread: string,
  input: unknown,
): Promise<T> {
  const url = `${endpoint.url}/spider/${desk}/json/${thread}/json`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookie = await authCookie(endpoint);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify(input),
    });

    if (res.ok) return (await res.json()) as T;

    if (attempt === 0 && (res.status === 401 || res.status === 403)) {
      forgetCookie(endpoint.url);
      continue;
    }

    const body = (await res.text()).slice(0, 500);
    throw new Error(`thread ${desk}/${thread} failed (HTTP ${res.status})${body ? `: ${body}` : ''}`);
  }
  throw new Error(`thread ${desk}/${thread} failed: could not authenticate`);
}
