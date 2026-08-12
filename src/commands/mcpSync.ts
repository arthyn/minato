import { loadConfig, loadState } from '../config.ts';
import { readAllPiers } from '../discover.ts';
import { auditMcp, syncMcp } from '../mcp.ts';
import { color, confirm } from '../ui.ts';
import { EXIT_OK } from './start.ts';

export interface McpOptions {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export async function mcpStatusCommand(opts: McpOptions): Promise<number> {
  const config = loadConfig();
  const piers = readAllPiers(config, loadState());
  const entries = auditMcp(config, piers);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return entries.every((e) => e.status === 'ok') ? 0 : 1;
  }

  for (const entry of entries) {
    const mark =
      entry.status === 'ok' ? color('green', '  ok') : color('yellow', entry.status.padStart(4));
    const scope = entry.ref.scope === 'global' ? '' : ` ${entry.ref.scope}`;
    process.stdout.write(
      `${mark}  ${color('dim', entry.ref.agent.padEnd(6))} ${color('bold', entry.ref.name)}` +
        `${color('dim', scope)}  ${entry.detail}\n`,
    );
  }
  return entries.every((e) => e.status === 'ok') ? 0 : 1;
}

export async function mcpSyncCommand(opts: McpOptions): Promise<number> {
  const config = loadConfig();
  const piers = readAllPiers(config, loadState());
  const preview = syncMcp(config, piers, true);

  if (preview.changed.length === 0) {
    process.stdout.write('no port drift to fix\n');
    if (preview.skipped.length > 0) {
      process.stdout.write(
        color('dim', `${preview.skipped.length} entries need attention (minato doctor)\n`),
      );
    }
    return EXIT_OK;
  }

  process.stdout.write(`${color('bold', 'will rewrite')}\n`);
  for (const entry of preview.changed) {
    process.stdout.write(
      `  ${entry.ref.agent}: ${entry.ref.name}  ${entry.ref.port} -> ${entry.expectedPort}\n`,
    );
  }
  if (opts.dryRun) return EXIT_OK;

  if (!opts.yes && !(await confirm('apply?'))) {
    process.stdout.write('cancelled\n');
    return EXIT_OK;
  }

  const result = syncMcp(config, piers, false);
  process.stdout.write(`${color('green', 'updated')} ${result.changed.length} entries\n`);
  for (const b of result.backups) process.stdout.write(color('dim', `  backup: ${b}\n`));
  process.stdout.write(color('dim', 'restart the affected agent to pick up the new endpoints\n'));
  return EXIT_OK;
}
