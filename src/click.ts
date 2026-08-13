import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `click` drives a local ship through its `conn.sock` control plane, which is
 * how anything that needs real Hoon values (rather than the JSON marks Eyre is
 * limited to) has to talk to a ship.
 *
 * It is an external bash script, not bundled here. Several copies usually exist
 * and they are not equivalent — see `findClick`.
 */
const CLICK_CANDIDATES = [
  join(homedir(), 'Projects/tlon-apps/backend/click'),
  join(homedir(), 'Projects/tools/pkg/click/click'),
];

export class ClickError extends Error {}

export interface Click {
  path: string;
  /** True if this copy handles BSD netcat, i.e. works on macOS. */
  bsdSafe: boolean;
}

/**
 * Locate a usable `click`.
 *
 * Copies differ in a way that matters: some pass netcat's timeout as `-W`,
 * which is netcat-openbsd only, so on macOS they hang or fail. A usable copy
 * either detects the platform or uses the BSD `-w` form.
 */
export function findClick(explicit?: string): Click | null {
  const inspect = (path: string): Click | null => {
    if (!existsSync(path)) return null;
    let body = '';
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    const bsdSafe = body.includes('NC_TIMEOUT_FLAG') || body.includes('darwin');
    return { path, bsdSafe };
  };

  // An explicitly named click is used or rejected on its own merits. Silently
  // falling back to a different copy would run against a binary the caller did
  // not choose.
  if (explicit) {
    const found = inspect(explicit);
    if (!found) throw new ClickError(`no click at ${explicit}`);
    if (process.platform === 'darwin' && !found.bsdSafe) {
      throw new ClickError(
        `${explicit} passes netcat's timeout as -W, which is netcat-openbsd only; ` +
          'it will not work on macOS',
      );
    }
    return found;
  }

  for (const path of CLICK_CANDIDATES) {
    const found = inspect(path);
    if (found && (process.platform !== 'darwin' || found.bsdSafe)) return found;
  }
  return null;
}

/**
 * Run a strand on a local ship and return click's raw output.
 *
 * Every line is emitted with **two trailing spaces**. click concatenates the
 * input, and without that padding the hoon parses as one run-together
 * expression and fails with a syntax error — verified against a live ship.
 */
export function runStrand(
  click: Click,
  pierPath: string,
  hoonLines: string[],
  timeoutSeconds = 300,
): string {
  const source = `${hoonLines.map((l) => `${l}  `).join('\n')}\n`;
  let out: string;
  try {
    out = execFileSync(
      click.path,
      ['-t', String(timeoutSeconds), '-i', '-', '-kp', pierPath],
      {
        input: source,
        encoding: 'utf8',
        timeout: (timeoutSeconds + 30) * 1000,
        maxBuffer: 8 << 20,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new ClickError(
      `click failed: ${(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' / ')}`,
    );
  }

  // click reports thread failures in its output rather than the exit code.
  if (/thread-fail|syntax error|%crash|bail:/i.test(out)) {
    throw new ClickError(`thread failed: ${out.trim().split('\n').slice(-4).join(' / ')}`);
  }
  return out;
}

/** A strand that pokes one agent and returns %ok. */
export function pokeStrand(app: string, mark: string, value: string): string[] {
  return [
    '=/  m  (strand ,vase)',
    ';<  =bowl  bind:m  get-bowl',
    `;<  ~  bind:m  (poke [our.bowl ${app}] ${mark}+!>(${value}))`,
    '(pure:m !>(%ok))',
  ];
}
