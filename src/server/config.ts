// Settings resolve in this order: ORA_* environment variable, config file, built-in default.
import { dirname, join } from 'node:path';

export interface Config {
  port: number;
  llamaPort: number;
  llamaServer: string;
  llamaArgs: string[];
  modelsDir: string;
  dataDir: string;
  distDir: string | null;
}

type Env = Record<string, string | undefined>;

export function configPath(env: Env): string {
  if (env.ORA_CONFIG) return env.ORA_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? env.USERPROFILE ?? '.', '.config');
  return join(base, 'ora', 'config.json');
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function port(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

// Extra llama-server flags: a list in the file, or a space-separated string in ORA_LLAMA_ARGS.
function argList(envValue: string | undefined, fileValue: unknown): string[] {
  if (envValue?.trim()) return envValue.trim().split(/\s+/);
  if (Array.isArray(fileValue) && fileValue.every(v => typeof v === 'string')) return fileValue as string[];
  return [];
}

function parseFile(fileText: string | null): Record<string, unknown> {
  if (fileText === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch (e) {
    throw new Error(`invalid config file: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('invalid config file: expected a JSON object');
  return parsed as Record<string, unknown>;
}

export function loadConfig(env: Env, fileText: string | null): Config {
  const file = parseFile(fileText);
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return {
    port: port(env.ORA_PORT) ?? port(file.port) ?? 8800,
    llamaPort: port(env.ORA_LLAMA_PORT) ?? port(file.llamaPort) ?? 8099,
    llamaServer: text(env.ORA_LLAMA_SERVER) ?? text(file.llamaServer) ?? 'llama-server',
    llamaArgs: argList(env.ORA_LLAMA_ARGS, file.llamaArgs),
    modelsDir: text(env.ORA_MODELS_DIR) ?? text(file.modelsDir) ?? join(dirname(configPath(env)), 'models'),
    dataDir: text(env.ORA_DATA) ?? text(file.dataDir) ?? join(dataHome, 'ora'),
    distDir: text(env.ORA_DIST) ?? text(file.distDir) ?? null,
  };
}
