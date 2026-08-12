import { createInterface } from 'node:readline/promises';
import type { PierState } from './types.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const CODES: Record<string, string> = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

export function color(name: keyof typeof CODES, text: string): string {
  return useColor ? `${CODES[name]}${text}${CODES.reset}` : text;
}

const STATE_COLOR: Record<PierState, keyof typeof CODES> = {
  running: 'green',
  stopped: 'dim',
  stale: 'yellow',
  ambiguous: 'red',
  unknown: 'red',
  archived: 'dim',
};

export function stateLabel(state: PierState): string {
  return color(STATE_COLOR[state], state);
}

/** Visible width, ignoring the SGR escapes added by `color`. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))),
  );
  const pad = (cell: string, i: number): string =>
    cell + ' '.repeat(Math.max(0, widths[i] - width(cell)));
  const lines = [headers.map((h, i) => color('bold', pad(h, i))).join('  ')];
  for (const row of rows) lines.push(headers.map((_, i) => pad(row[i] ?? '', i)).join('  '));
  return lines.join('\n');
}

export function humanBytes(bytes: number | null): string {
  if (bytes === null) return '';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

export function humanAge(date: Date | null): string {
  if (!date) return 'never';
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('confirmation required but stdin is not a terminal — pass --yes');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function fail(message: string, exitCode: number): never {
  process.stderr.write(`${color('red', 'error')} ${message}\n`);
  process.exit(exitCode);
}
