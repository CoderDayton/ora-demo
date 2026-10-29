// The tools the model may call: plain data, so the turn loop and the UI can list them without running anything.
// Groups are switched on in the settings; `ask` tools wait for the user's Allow or Deny before they run.

import type { Json } from '../llm/llama.ts';

export type Group = 'docs' | 'utility' | 'web' | 'system';
export const GROUPS: Group[] = ['docs', 'utility', 'web', 'system'];

export interface ToolInfo {
  name: string;
  group: Group;
  ask: boolean;
  // A short line the voice says when the tool starts.
  say: string;
  description: string;
  parameters: Json;
}

const text = (description: string): Json => ({ type: 'string', description });
const num = (description: string): Json => ({ type: 'integer', description });
const params = (properties: Json, required: string[]): Json => ({ type: 'object', properties, required });

export const TOOLS: ToolInfo[] = [
  {
    name: 'search_documents',
    group: 'docs',
    ask: false,
    say: 'Searching your documents.',
    description:
      'Full-text search in the text documents uploaded to this chat. Returns the best-matching passages with their document name and part number.',
    parameters: params({ query: text('Words to look for.'), limit: num('How many passages to return, 1 to 8. Default 4.') }, ['query']),
  },
  {
    name: 'read_document',
    group: 'docs',
    ask: false,
    say: 'Reading the document.',
    description: 'Reads one part (about 1200 characters) of a text document uploaded to this chat. Part numbers start at 0.',
    parameters: params({ document: text('The document name.'), part: num('The part number, from 0.') }, ['document', 'part']),
  },
  {
    name: 'current_time',
    group: 'utility',
    ask: false,
    say: 'Checking the time.',
    description: 'The current date and time.',
    parameters: params({}, []),
  },
  {
    name: 'calculate',
    group: 'utility',
    ask: false,
    say: 'Calculating.',
    description: 'Evaluates an arithmetic expression with + - * / % ^ and parentheses. Use it instead of doing arithmetic yourself.',
    parameters: params({ expression: text('For example (12.5 + 3) * 4 / 5.') }, ['expression']),
  },
  {
    name: 'web_search',
    group: 'web',
    ask: false,
    say: 'Searching the web.',
    description:
      'Searches the web and returns result titles, addresses and snippets. Only for current or changing information (prices, news, weather, scores) or facts you do not know; not for general knowledge or creative writing.',
    parameters: params({ query: text('What to search for.') }, ['query']),
  },
  {
    name: 'web_fetch',
    group: 'web',
    ask: false,
    say: 'Fetching the page.',
    description: 'Downloads a web page (http or https) and returns its text.',
    parameters: params({ url: text('The full address.') }, ['url']),
  },
  {
    name: 'run_command',
    group: 'system',
    ask: true,
    say: 'I would like to run a command.',
    description: 'Runs a shell command in the work folder and returns its output and exit code. The user approves every command first.',
    parameters: params({ command: text('The shell command.') }, ['command']),
  },
  {
    name: 'read_file',
    group: 'system',
    ask: true,
    say: 'I would like to read a file.',
    description: 'Reads a text file inside the work folder.',
    parameters: params({ path: text('Path relative to the work folder.') }, ['path']),
  },
  {
    name: 'write_file',
    group: 'system',
    ask: true,
    say: 'I would like to write a file.',
    description: 'Writes a text file inside the work folder, replacing it if it exists.',
    parameters: params({ path: text('Path relative to the work folder.'), content: text('The whole file.') }, ['path', 'content']),
  },
  {
    name: 'list_dir',
    group: 'system',
    ask: true,
    say: 'I would like to list a folder.',
    description: 'Lists the files in a folder inside the work folder.',
    parameters: params({ path: text('Path relative to the work folder. Default is the folder itself.') }, []),
  },
];

export function find(name: string): ToolInfo | null {
  return TOOLS.find(t => t.name === name) ?? null;
}

// Tool definitions in the OpenAI format llama-server expects, for the given groups.
export function definitions(groups: string[]): Json[] {
  return TOOLS.filter(t => groups.includes(t.group)).map(
    (t: ToolInfo): Json => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }),
  );
}

const arg = (args: Json, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};

// One line saying what a call does, for the transcript and for the approval question.
export function summarize(name: string, args: Json): string {
  switch (name) {
    case 'run_command':
      return `Run the command: ${arg(args, 'command')}`;
    case 'read_file':
      return `Read the file ${arg(args, 'path')}`;
    case 'write_file':
      return `Write the file ${arg(args, 'path')}`;
    case 'list_dir':
      return `List the folder ${arg(args, 'path') || '.'}`;
    case 'web_fetch':
      return `Fetch ${arg(args, 'url')}`;
    case 'web_search':
      return `Search the web for "${arg(args, 'query')}"`;
    case 'search_documents':
      return `Search the documents for "${arg(args, 'query')}"`;
    case 'read_document':
      return `Read ${arg(args, 'document')}, part ${arg(args, 'part')}`;
    case 'calculate':
      return `Calculate ${arg(args, 'expression')}`;
    case 'current_time':
      return 'Check the time';
    default:
      return name;
  }
}
