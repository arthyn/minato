import { loadConfig, loadState, saveState, setMeta } from '../config.ts';
import { readAllPiers, readPier, resolvePier } from '../discover.ts';
import { processTable } from '../live.ts';
import { color, confirm } from '../ui.ts';
import { EXIT_FAILED, EXIT_OK, EXIT_SAFETY } from './start.ts';

export interface StopOptions {
  moon: string;
  yes?: boolean;
  timeout?: number;
}

const DEFAULT_TIMEOUT_S = 90;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopCommand(opts: StopOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state);
  const pier = resolvePier(piers, opts.moon);

  if (pier.livenessSource !== 'process-table') {
    // Without the process table there is no king pid to signal — the lock file
    // names the serf, and killing a serf directly can lose events.
    process.stderr.write(
      `${color('red', 'refusing to stop')} ~${pier.ship}: no process table, so the\n` +
        'supervising process cannot be identified. Run outside the sandbox.\n',
    );
    return EXIT_SAFETY;
  }
  if (pier.state === 'stopped' || pier.state === 'stale') {
    process.stdout.write(`~${pier.ship} is not running\n`);
    return EXIT_OK;
  }
  if (pier.state === 'ambiguous' || pier.state === 'unknown' || !pier.kingPid) {
    // With two kings there is no single correct process to signal, and picking
    // one could snapshot-corrupt the pier. Hand it back to the operator.
    process.stderr.write(
      `${color('red', 'refusing to stop')} ~${pier.ship}: runtime state is ${pier.state}\n`,
    );
    for (const issue of pier.issues) process.stderr.write(`  ${issue.message}\n`);
    return EXIT_SAFETY;
  }

  if (!opts.yes) {
    const ok = await confirm(
      `stop ~${pier.ship} (pid ${pier.kingPid}, port ${pier.ports.public ?? '?'})?`,
    );
    if (!ok) {
      process.stdout.write('cancelled\n');
      return EXIT_OK;
    }
  }

  // SIGTERM is vere's graceful shutdown: it snapshots and exits. SIGKILL is
  // never sent automatically (spec §5.1) — a killed serf can lose events.
  process.stdout.write(`sending SIGTERM to ~${pier.ship} (pid ${pier.kingPid})…\n`);
  try {
    process.kill(pier.kingPid, 'SIGTERM');
  } catch (err) {
    process.stderr.write(`${color('red', 'error')} could not signal: ${(err as Error).message}\n`);
    return EXIT_FAILED;
  }

  const timeoutS = opts.timeout ?? DEFAULT_TIMEOUT_S;
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const fresh = readPier(pier.path, config, state, processTable(), {});
    if (fresh.pids.length === 0) {
      setMeta(state, pier.path, { desiredPort: pier.ports.public });
      saveState(state);
      process.stdout.write(`${color('green', 'stopped')} ~${pier.ship}\n`);
      return EXIT_OK;
    }
  }

  process.stderr.write(
    `${color('yellow', 'warn')} ~${pier.ship} still running ${timeoutS}s after SIGTERM.\n` +
      `It may be writing a snapshot. minato will not escalate to SIGKILL;\n` +
      `wait, or force it yourself with: kill -9 ${pier.kingPid}\n`,
  );
  return EXIT_FAILED;
}
