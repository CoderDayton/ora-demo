// Runs one tool call. Anything thrown becomes the tool's error text, which the model reads and can react to.

import type { Cancel, Json } from '../llm/llama.ts';
import type { Store } from '../store/store.ts';
import { readDocument, searchDocuments } from './docs.ts';
import { listDir, readFile, runCommand, writeFile } from './system.ts';
import { calculate, currentTime } from './utility.ts';
import { fetchPage, searchWeb } from './web.ts';

// `allowed` is the ceiling set in the config; a request can only switch on groups inside it.
export interface ToolEnv {
  allowed: string[];
  workDir: string;
  searchUrl: string;
}

const COMMAND_MS = 60_000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);

export async function runTool(name: string, args: Json, env: ToolEnv, store: Store, chatId: number, cancel: Cancel): Promise<string> {
  switch (name) {
    case 'search_documents':
      return searchDocuments(store, chatId, str(args.query), int(args.limit, 4));
    case 'read_document':
      return readDocument(store, chatId, str(args.document), int(args.part, 0));
    case 'current_time':
      return currentTime();
    case 'calculate':
      return calculate(str(args.expression));
    case 'web_search':
      return searchWeb(env.searchUrl, str(args.query));
    case 'web_fetch':
      return fetchPage(str(args.url));
    case 'run_command':
      return runCommand(str(args.command), env.workDir, COMMAND_MS, cancel);
    case 'read_file':
      return readFile(env.workDir, str(args.path));
    case 'write_file':
      return writeFile(env.workDir, str(args.path), str(args.content));
    case 'list_dir':
      return listDir(env.workDir, str(args.path));
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
