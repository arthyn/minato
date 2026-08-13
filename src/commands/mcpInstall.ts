import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfig, loadState } from '../config.ts';
import { readAllPiers, resolvePier } from '../discover.ts';
import { findClick, pokeStrand, runStrand, type Click } from '../click.ts';
import type { Pier } from '../types.ts';
import { color, confirm } from '../ui.ts';
import { EXIT_FAILED, EXIT_OK, EXIT_SAFETY, EXIT_VALIDATION } from './start.ts';

export interface McpInstallOptions {
  moon: string;
  /** Checkout of the desk source, default ~/Projects/mcp (tloncorp/mcp). */
  repo?: string;
  click?: string;
  yes?: boolean;
  dryRun?: boolean;
}

const DEFAULT_REPO = join(homedir(), 'Projects/mcp');

/**
 * Empty a mounted desk directory, leaving the directory itself in place.
 *
 * Guarded rather than trusting the caller: this deletes recursively, so it
 * refuses anything that is not a `<pier>/mcp` mount holding a `sys.kelvin`.
 */
function clearDesk(deskPath: string): void {
  if (basename(deskPath) !== 'mcp' || !existsSync(join(deskPath, 'sys.kelvin'))) {
    throw new Error(`refusing to clear ${deskPath}: does not look like a mounted %mcp desk`);
  }
  for (const entry of readdirSync(deskPath)) {
    rmSync(join(deskPath, entry), { recursive: true, force: true });
  }
}

/**
 * Install %mcp onto a local ship, following the documented build:
 *
 *   |merge %mcp our %base   (create the desk)
 *   |mount %mcp
 *   zig build -Ddesk=<pier>/mcp
 *   |commit %mcp
 *   |install our %mcp
 *
 * The dojo steps go through click, since they need real Hoon values that Eyre's
 * JSON marks cannot express. This only works on a ship whose pier is on this
 * machine — `conn.sock` is local by nature.
 */
export async function mcpInstallCommand(opts: McpInstallOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const pier = resolvePier(readAllPiers(config, state), opts.moon);

  if (pier.archived) {
    process.stderr.write(`${color('red', 'refusing')} ~${pier.ship} is archived\n`);
    return EXIT_SAFETY;
  }
  if (pier.state !== 'running') {
    process.stderr.write(
      `${color('red', 'error')} ~${pier.ship} is ${pier.state}; it must be running\n`,
    );
    return EXIT_VALIDATION;
  }

  const repo = opts.repo ?? DEFAULT_REPO;
  if (!existsSync(join(repo, 'build.zig'))) {
    process.stderr.write(
      `${color('red', 'error')} no desk source at ${repo}\n` +
        'clone tloncorp/mcp, or pass --repo <path>\n',
    );
    return EXIT_VALIDATION;
  }

  const click = findClick(opts.click);
  if (!click) {
    process.stderr.write(
      `${color('red', 'error')} no usable click found.\n` +
        'click drives the ship over conn.sock; pass --click <path>.\n' +
        (process.platform === 'darwin'
          ? 'On macOS it must be a copy that handles BSD netcat — the one in\n' +
            'tlon-apps/backend does, the one in tools/pkg/click does not.\n'
          : ''),
    );
    return EXIT_VALIDATION;
  }

  const deskPath = join(pier.path, 'mcp');
  process.stdout.write(`${color('bold', 'plan')} — install %mcp on ~${pier.ship}\n`);
  process.stdout.write(`  desk source  ${repo}\n`);
  process.stdout.write(`  click        ${click.path}\n`);
  process.stdout.write(`  mount at     ${deskPath}\n`);
  if (opts.dryRun) {
    process.stdout.write(`\n${color('dim', 'dry run — nothing was changed')}\n`);
    return EXIT_OK;
  }
  if (!opts.yes && !(await confirm(`\ninstall %mcp on ~${pier.ship}?`))) {
    process.stdout.write('cancelled\n');
    return EXIT_OK;
  }

  const step = (label: string): void => {
    process.stdout.write(`${color('dim', `· ${label}`)}\n`);
  };

  try {
    // A desk has to exist before it can be mounted; merging from %base is the
    // simplest way to create one without reimplementing |new-desk's file map.
    if (!existsSync(deskPath)) {
      step('creating %mcp from %base');
      runStrand(click, pier.path, [
        '=/  m  (strand ,vase)',
        ';<  =bowl  bind:m  get-bowl',
        ';<  ~  bind:m  (poke [our.bowl %hood] kiln-merge+!>([%mcp our.bowl %base da+now.bowl %init]))',
        '(pure:m !>(%ok))',
      ]);

    }

    // Unmount before mounting, even on a fresh desk. A mount Clay is no longer
    // tracking accepts file writes but makes the later |commit a silent no-op,
    // which fails by appearing to succeed.
    step('mounting %mcp');
    runStrand(click, pier.path, [
      '=/  m  (strand ,vase)',
      ';<  =bowl  bind:m  get-bowl',
      ';<  ~  bind:m  (poke [our.bowl %hood] kiln-unmount+!>(%mcp))',
      ';<  ~  bind:m  (sleep ~s1)',
      '=/  =path  [(scot %p our.bowl) %mcp (scot %da now.bowl) ~]',
      ';<  ~  bind:m  (poke [our.bowl %hood] kiln-mount+!>([path %mcp]))',
      '(pure:m !>(%ok))',
    ]);

    // Wait for Clay to finish writing the mount out before touching it.
    for (let i = 0; i < 30 && !existsSync(join(deskPath, 'sys.kelvin')); i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Creating the desk by merging %base leaves that desk's files behind, and
    // the build copies in without deleting — so the desk would carry all of
    // %base's gen/ and sys/ alongside %mcp. Emptying it first makes the commit
    // produce exactly the built desk.
    clearDesk(deskPath);

    // zig replaces the mounted desk's contents with /dist — the desk source
    // plus its resolved dependencies.
    step(`building desk source into ${deskPath}`);
    execFileSync('zig', ['build', `-Ddesk=${deskPath}`], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    step('committing %mcp');
    runStrand(click, pier.path, pokeStrand('%hood', 'kiln-commit', '[%mcp %.n]'));

    step('installing %mcp');
    runStrand(click, pier.path, pokeStrand('%hood', 'kiln-install', '[%mcp our.bowl %mcp]'));
  } catch (err) {
    process.stderr.write(`\n${color('red', 'failed')} ${(err as Error).message}\n`);
    process.stderr.write(
      `The desk may be partly installed. Inspect ${deskPath} and the ship's dojo.\n`,
    );
    return EXIT_FAILED;
  }

  process.stdout.write(`\n${color('green', 'installed')} %mcp on ~${pier.ship}\n`);
  process.stdout.write(
    color(
      'dim',
      'next: get the ship\'s +code, log in for an urbauth cookie, and register the\n' +
        `endpoint at http://localhost:${pier.ports.public ?? '?'}/mcp with your agents.\n`,
    ),
  );
  return EXIT_OK;
}

/** Best-effort install used by `new`; never fails the boot it follows. */
export async function tryInstallMcp(pier: Pier, opts: McpInstallOptions): Promise<void> {
  try {
    await mcpInstallCommand({ ...opts, moon: pier.path, yes: true });
  } catch (err) {
    process.stderr.write(
      color('yellow', `warn  %mcp install skipped: ${(err as Error).message}\n`),
    );
  }
}
