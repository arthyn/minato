import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getMeta, loadConfig, loadState, saveState, setMeta } from '../config.ts';
import { readAllPiers, readPier, resolvePier } from '../discover.ts';
import { auditMcp } from '../mcp.ts';
import { checkPort, processTable } from '../live.ts';
import type { Pier } from '../types.ts';
import { color, confirm } from '../ui.ts';
import { attachCommand, sessionName, sessionToolAvailable, wrapForSession, type SessionKind } from '../session.ts';

export interface StartOptions {
  moon: string;
  port?: number;
  yes?: boolean;
  json?: boolean;
  /** Override the configured supervision mode for this boot. */
  session?: SessionKind;
}

export const EXIT_OK = 0;
export const EXIT_VALIDATION = 2;
export const EXIT_SAFETY = 4;
export const EXIT_FAILED = 5;

const BOOT_TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Choose the port to boot on, preferring whatever agents already expect to find
 * the ship at, so starting a moon doesn't silently invalidate its MCP entry.
 */
function choosePort(pier: Pier, explicit: number | undefined, mcpPort: number | null): number | null {
  return (
    explicit ?? getMeta(loadState(), pier.path).desiredPort ?? pier.ports.public ?? mcpPort ?? null
  );
}

export async function startCommand(opts: StartOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state);
  const pier = resolvePier(piers, opts.moon);

  // ---- preflight ----
  //
  // Archived piers are hard-blocked, with no --yes or --force override. These
  // are typically copies of a ship whose live instance runs elsewhere, and
  // booting a second instance can corrupt the live one. Unarchiving is a
  // separate, deliberate act.
  if (pier.archived) {
    process.stderr.write(
      `${color('red', 'refusing to start')} ~${pier.ship}: this pier is archived.\n` +
        `  ${pier.path}\n` +
        (getMeta(state, pier.path).notes
          ? `  note: ${getMeta(state, pier.path).notes}\n`
          : '') +
        'Archived piers are never booted. If you are certain, run:\n' +
        `  minato unarchive ${pier.shortname}\n`,
    );
    return EXIT_SAFETY;
  }

  if (pier.livenessSource !== 'process-table') {
    // Inference can confirm a ship is up but cannot detect a second boot, and
    // cannot establish that a ship is down. Neither is a basis for booting.
    process.stderr.write(
      `${color('red', 'refusing to start')} ~${pier.ship}: no process table, so a duplicate\n` +
        'boot could not be detected. Run outside the sandbox, or start it yourself.\n',
    );
    return EXIT_SAFETY;
  }
  if (pier.state === 'running') {
    process.stdout.write(
      `~${pier.ship} is already running on port ${pier.ports.public ?? '?'} (pid ${pier.kingPid})\n`,
    );
    return EXIT_OK;
  }
  if (pier.state === 'ambiguous' || pier.state === 'unknown') {
    // Starting without confirmed liveness risks a duplicate boot, which is the
    // single outcome this tool exists to prevent.
    process.stderr.write(
      `${color('red', 'refusing to start')} ~${pier.ship}: runtime state is ${pier.state}\n`,
    );
    for (const issue of pier.issues) process.stderr.write(`  ${issue.message}\n`);
    process.stderr.write('resolve by hand, then retry\n');
    return EXIT_SAFETY;
  }

  const runPath = join(pier.path, '.run');
  if (!existsSync(runPath)) {
    process.stderr.write(`${color('red', 'error')} ${runPath} is missing — pier has no vere binary\n`);
    return EXIT_VALIDATION;
  }

  // Prefer the port agents already expect, so starting a moon doesn't quietly
  // invalidate the MCP entries that point at it.
  const mcpEntries = auditMcp(config, piers).filter(
    (e) => e.ref.name.toLowerCase().replace(/_/g, '-') === pier.shortname.toLowerCase(),
  );
  const port = choosePort(pier, opts.port, mcpEntries[0]?.ref.port ?? null);
  if (!port) {
    process.stderr.write(
      `${color('red', 'error')} no port known for ~${pier.ship} — pass --port\n`,
    );
    return EXIT_VALIDATION;
  }

  const portStatus = await checkPort(port);
  if (portStatus === 'in-use') {
    const holder = piers.find((p) => p.state === 'running' && p.ports.public === port);
    process.stderr.write(
      `${color('red', 'refusing to start')} port ${port} is already bound${
        holder ? ` by ~${holder.ship}` : ''
      }\n`,
    );
    return EXIT_SAFETY;
  }
  if (portStatus === 'unknown') {
    process.stdout.write(
      color('yellow', `warn  cannot verify port ${port} is free (privileged port)\n`),
    );
    if (!opts.yes && !(await confirm(`start ~${pier.ship} on port ${port} anyway?`))) {
      return EXIT_SAFETY;
    }
  }

  // ---- boot ----
  const mode: SessionKind = opts.session ?? config.sessionMode ?? 'daemon';
  if (!sessionToolAvailable(mode)) {
    process.stderr.write(`${color('red', 'error')} ${mode} is not installed\n`);
    return EXIT_VALIDATION;
  }

  // Under screen/tmux the ship runs *without* -d, so it keeps its terminal and
  // stays attachable for a dojo; the session is what detaches it. With -d there
  // is no terminal to attach to at all.
  const name = sessionName(pier.shortname);
  const runArgs =
    mode === 'daemon'
      ? ['-d', '--http-port', String(port)]
      : ['--http-port', String(port)];
  const { file, argv } = wrapForSession(mode, name, runPath, runArgs);

  process.stdout.write(
    `starting ~${pier.ship} on port ${port}` +
      (mode === 'daemon' ? '' : ` in ${mode} session ${color('bold', name)}`) +
      '…\n',
  );
  const child = spawn(file, argv, {
    cwd: pier.path,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const fresh = readPier(pier.path, config, state, processTable(), {});
    if (fresh.state === 'running' && fresh.ports.public) {
      setMeta(state, pier.path, { desiredPort: fresh.ports.public });
      saveState(state);
      process.stdout.write(
        `${color('green', 'running')} ~${fresh.ship} on ${fresh.ports.public} (pid ${fresh.kingPid})\n`,
      );
      if (fresh.session) {
        process.stdout.write(
          color('dim', `  dojo: minato dojo ${pier.shortname}  (${attachCommand(fresh.session).join(' ')})\n`),
        );
      }
      for (const entry of mcpEntries) {
        if (entry.ref.port !== fresh.ports.public) {
          process.stdout.write(
            color(
              'yellow',
              `warn  ${entry.ref.agent} mcp entry "${entry.ref.name}" points at ` +
                `${entry.ref.port} — run: minato mcp sync\n`,
            ),
          );
        }
      }
      return EXIT_OK;
    }
    if (fresh.state === 'ambiguous') {
      process.stderr.write(`${color('red', 'boot produced an ambiguous state')}\n`);
      for (const issue of fresh.issues) process.stderr.write(`  ${issue.message}\n`);
      return EXIT_SAFETY;
    }
  }

  process.stderr.write(
    `${color('red', 'error')} ~${pier.ship} did not come up within ${BOOT_TIMEOUT_MS / 1000}s\n` +
      `check the pier directly: ${pier.path}\n`,
  );
  return EXIT_FAILED;
}
