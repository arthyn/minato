import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { Config, State, MoonMeta } from './types.ts';
import { defaultAgentConfigPaths } from './agents.ts';

export const MINATO_DIR = join(homedir(), '.minato');
const CONFIG_PATH = join(MINATO_DIR, 'config.json');
const STATE_PATH = join(MINATO_DIR, 'state.json');

const DEFAULT_CONFIG: Config = {
  version: 1,
  roots: [homedir()],
  scanDepth: 3,
  staleAfterDays: 14,
  agentConfigs: defaultAgentConfigPaths(),
};

const DEFAULT_STATE: State = { version: 1, moons: {} };

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(path, 'utf8')) as object) } as T;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Write via temp file + rename so a crash can never leave a truncated store. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(MINATO_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function loadConfig(): Config {
  return readJson(CONFIG_PATH, DEFAULT_CONFIG);
}

export function saveConfig(config: Config): void {
  writeJsonAtomic(CONFIG_PATH, config);
}

export function loadState(): State {
  return readJson(STATE_PATH, DEFAULT_STATE);
}

export function saveState(state: State): void {
  writeJsonAtomic(STATE_PATH, state);
}

/**
 * Metadata is keyed by pier path, not ship name: four separate `zod` piers live
 * under this home directory, so the ship name is not a unique key.
 */
export function getMeta(state: State, pierPath: string): MoonMeta {
  return state.moons[pierPath] ?? {};
}

export function setMeta(state: State, pierPath: string, patch: MoonMeta): void {
  state.moons[pierPath] = { ...getMeta(state, pierPath), ...patch };
}
