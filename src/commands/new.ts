import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadState, saveConfig, saveState, setMeta } from '../config.ts';
import { findPierPaths, readAllPiers, readPier } from '../discover.ts';
import { checkPort, processTable } from '../live.ts';
import { readSecret, resolveEndpoint, runThread, shipRank } from '../eyre.ts';
import type { Config, State } from '../types.ts';
import { resolveVere } from '../vere.ts';
import { color, confirm } from '../ui.ts';
import { tryInstallMcp } from './mcpInstall.ts';
import { EXIT_FAILED, EXIT_OK, EXIT_SAFETY, EXIT_VALIDATION } from './start.ts';

export interface NewOptions {
  shortname?: string;
  planet?: string;
  dir?: string;
  port?: number;
  desk?: string;
  hosted?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  /** Adopt a moon already minted by `|moon`, rather than running the thread. */
  ship?: string;
  keyFile?: string;
  /** Install %mcp after boot. On by default; --no-mcp opts out. */
  mcp?: boolean;
  mcpRepo?: string;
}

interface GenMoonResult {
  ship: string;
  key: string;
}

const BOOT_TIMEOUT_MS = 600_000;
const POLL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a moon's private key.
 *
 * There is deliberately no `--key` flag: anything in argv is visible to every
 * process on the machine via `ps`. The key arrives from a file, from stdin when
 * piped, or from an echo-less prompt.
 */
async function readMoonKey(keyFile?: string): Promise<string> {
  if (keyFile) return readFileSync(keyFile, 'utf8').trim();
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').trim();
  return (await readSecret('moon key (0w…, not echoed): ')).trim();
}

/** First free port at or above `from`, skipping anything already bound. */
async function pickPort(from: number): Promise<number> {
  for (let port = from; port < from + 200; port += 1) {
    if ((await checkPort(port)) === 'free') return port;
  }
  throw new Error(`no free port found above ${from}`);
}

export async function newCommand(opts: NewOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state);

  // ---- validate up front, before asking for a password ----
  if (opts.shortname) {
    if (!/^[a-z][a-z0-9-]*$/.test(opts.shortname)) {
      process.stderr.write(`invalid shortname "${opts.shortname}" — use lowercase letters, digits, hyphens\n`);
      return EXIT_VALIDATION;
    }
    const taken = piers.find((p) => p.shortname.toLowerCase() === opts.shortname?.toLowerCase());
    if (taken) {
      process.stderr.write(`shortname "${opts.shortname}" is already used by ${taken.path}\n`);
      return EXIT_VALIDATION;
    }
  }

  // ---- adopt a moon minted by `|moon` in the parent's dojo ----
  //
  // `|moon` slogs the name and key to the ship's own terminal rather than
  // returning them, so there is no way to collect them over the network. When
  // the parent has no gen-moon thread, running it by hand and handing the
  // output here is the whole workflow.
  if (opts.ship) {
    const moon = opts.ship.replace(/^~/, '');
    if (!/^[a-z]+(-[a-z]+)*$/.test(moon)) {
      process.stderr.write(`invalid ship "${opts.ship}"\n`);
      return EXIT_VALIDATION;
    }
    if (shipRank(moon) !== 'moon') {
      process.stderr.write(`~${moon} is a ${shipRank(moon)}, not a moon\n`);
      return EXIT_VALIDATION;
    }

    const key = await readMoonKey(opts.keyFile);
    if (!key.startsWith('0w')) {
      process.stderr.write('that does not look like a moon key (expected it to start with 0w)\n');
      return EXIT_VALIDATION;
    }
    return bootMoon({ moon, key, config, state, opts });
  }

  const planet = opts.planet ?? config.planet;
  if (!planet) {
    process.stderr.write(
      'no parent planet configured — pass --planet <ship-or-url>\n' +
        '(a full URL is required for self-hosted ships; a bare ship name assumes <ship>.arvo.network)\n',
    );
    return EXIT_VALIDATION;
  }

  const endpoint = resolveEndpoint(planet, Boolean(opts.hosted));
  // The thread refuses on a moon or comet; catching it here avoids a password
  // prompt followed by a server-side rejection.
  if (endpoint.ship) {
    const rank = shipRank(endpoint.ship);
    if (rank === 'moon' || rank === 'comet') {
      process.stderr.write(
        `~${endpoint.ship} is a ${rank}; only a planet, star, or galaxy can issue moons\n`,
      );
      return EXIT_VALIDATION;
    }
  }

  const parentDir = opts.dir ?? config.roots[0] ?? homedir();
  const desk = opts.desk ?? 'groups';
  const port = opts.port ?? (await pickPort(8080));

  process.stdout.write(`${color('bold', 'plan')}\n`);
  process.stdout.write(`  parent    ${endpoint.url}\n`);
  process.stdout.write(`  thread    ${desk}/gen-moon\n`);
  process.stdout.write(`  pier dir  ${parentDir}/<moon>\n`);
  process.stdout.write(`  port      ${port}\n`);
  if (opts.shortname) process.stdout.write(`  shortname ${opts.shortname}\n`);

  if (opts.dryRun) {
    process.stdout.write(`\n${color('dim', 'dry run — no moon was minted')}\n`);
    return EXIT_OK;
  }

  // Minting is not reversible: the parent records the moon's keys, and the
  // name is derived randomly rather than chosen, so a mistake cannot be redone
  // under the same name.
  if (!opts.yes && !(await confirm('\nmint a new moon from this parent?'))) {
    process.stdout.write('cancelled\n');
    return EXIT_OK;
  }

  // ---- mint ----
  let result: GenMoonResult;
  try {
    result = await runThread<GenMoonResult>(endpoint, desk, 'gen-moon', null);
  } catch (err) {
    process.stderr.write(`${color('red', 'error')} ${(err as Error).message}\n`);
    return EXIT_FAILED;
  }

  if (!result?.ship || !result?.key) {
    process.stderr.write(`${color('red', 'error')} thread returned no ship/key\n`);
    return EXIT_FAILED;
  }

  // Remember the parent once one has worked, so later runs need no --planet.
  if (config.planet !== planet) {
    saveConfig({ ...config, planet });
  }

  const moon = result.ship.replace(/^~/, '');
  if (!/^[a-z-]+$/.test(moon)) {
    process.stderr.write(`${color('red', 'error')} thread returned an implausible ship: ${result.ship}\n`);
    return EXIT_FAILED;
  }

  process.stdout.write(`${color('green', 'minted')} ~${moon}\n`);
  return bootMoon({ moon, key: result.key, config, state, opts });
}

interface BootArgs {
  moon: string;
  key: string;
  config: Config;
  state: State;
  opts: NewOptions;
}

/**
 * Boot a freshly-issued moon into a new pier and record it. Shared by both
 * paths, since minting and adopting differ only in where the key came from.
 */
async function bootMoon({ moon, key, config, state, opts }: BootArgs): Promise<number> {
  const parentDir = opts.dir ?? config.roots[0] ?? homedir();
  const port = opts.port ?? (await pickPort(8080));
  const pierPath = join(parentDir, moon);

  if (existsSync(pierPath)) {
    // The moon already exists on the parent at this point, so say plainly what
    // was created even though the boot cannot proceed.
    process.stderr.write(
      `${color('red', 'error')} ${pierPath} already exists — cannot boot.\n` +
        `~${moon} exists on the parent; boot it by hand with its key.\n`,
    );
    return EXIT_FAILED;
  }

  // ---- boot ----
  const vere = await resolveVere(findPierPaths(config));
  process.stdout.write(
    `${color('dim', `booting with vere ${vere.version} (${vere.source})`)}\n`,
  );

  // The key is a secret: written 0700-dir/0600-file, passed by path rather
  // than argv, and removed as soon as the boot finishes.
  const keyDir = mkdtempSync(join(tmpdir(), 'minato-key-'));
  const keyFile = join(keyDir, 'moon.key');
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });

  try {
    const child = spawn(
      vere.path,
      ['-d', '-w', moon, '-k', keyFile, '-c', pierPath, '--http-port', String(port)],
      { cwd: parentDir, detached: true, stdio: 'ignore' },
    );
    child.unref();

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      if (!existsSync(pierPath)) continue;
      const fresh = readPier(pierPath, config, state, processTable(), {});
      if (fresh.state === 'running' && fresh.ports.public) {
        setMeta(state, pierPath, {
          desiredPort: fresh.ports.public,
          ...(opts.shortname ? { shortname: opts.shortname } : {}),
        });
        saveState(state);

        process.stdout.write(
          `${color('green', 'running')} ~${moon} on ${fresh.ports.public} ` +
            `(pid ${fresh.kingPid})\n  pier ${pierPath}\n`,
        );
        if (opts.mcp !== false) {
          process.stdout.write('\n');
          await tryInstallMcp(fresh, { moon: fresh.path, repo: opts.mcpRepo });
        } else {
          process.stdout.write(color('dim', '\nskipped %mcp install (--no-mcp)\n'));
        }
        return EXIT_OK;
      }
    }

    process.stderr.write(
      `${color('yellow', 'warn')} ~${moon} was minted and boot was started, but it did not\n` +
        `come up within ${BOOT_TIMEOUT_MS / 60000} minutes. Check ${pierPath}\n`,
    );
    return EXIT_FAILED;
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
}
