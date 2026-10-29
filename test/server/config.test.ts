import assert from 'node:assert';
import { test } from 'node:test';
import { configPath, loadConfig } from '../../src/server/config.ts';

function same(actual: unknown, expected: unknown): void {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

const HOME = { HOME: '/h' };

test('defaults hard-code nothing personal', () => {
  same(loadConfig(HOME, null), {
    port: 8800,
    llamaPort: 8099,
    llamaServer: 'llama-server',
    llamaArgs: [],
    modelsDir: '/h/.config/ora/models',
    dataDir: '/h/.local/share/ora',
    distDir: null,
    tools: ['docs', 'utility'],
    workDir: '/h/.local/share/ora/work',
    searchUrl: '',
    modelFilter: '',
  });
});

test('tools: the file and ORA_TOOLS choose the groups the page may switch on; unknown names are dropped', () => {
  same(loadConfig(HOME, JSON.stringify({ tools: ['docs', 'web', 'system'] })).tools, ['docs', 'web', 'system']);
  same(loadConfig({ HOME: '/h', ORA_TOOLS: 'utility, web' }, JSON.stringify({ tools: ['docs'] })).tools, ['utility', 'web']);
  same(loadConfig(HOME, JSON.stringify({ tools: ['docs', 'root', 5] })).tools, ['docs']);
  same(loadConfig({ HOME: '/h', ORA_TOOLS: 'none' }, null).tools, []);
});

test('modelFilter limits the model picker: file, then ORA_MODEL_FILTER', () => {
  same(loadConfig(HOME, JSON.stringify({ modelFilter: 'lfm3' })).modelFilter, 'lfm3');
  same(loadConfig({ HOME: '/h', ORA_MODEL_FILTER: 'omni' }, JSON.stringify({ modelFilter: 'lfm3' })).modelFilter, 'omni');
});

test('workDir follows dataDir; workDir and searchUrl can be set', () => {
  same(loadConfig({ HOME: '/h', ORA_DATA: '/d' }, null).workDir, '/d/work');
  const c = loadConfig({ HOME: '/h', ORA_WORKDIR: '/w', ORA_SEARCH_URL: 'http://127.0.0.1:8080/search?format=json&q={q}' }, null);
  same([c.workDir, c.searchUrl], ['/w', 'http://127.0.0.1:8080/search?format=json&q={q}']);
});

test('XDG_DATA_HOME moves the data directory', () => {
  same(loadConfig({ HOME: '/h', XDG_DATA_HOME: '/x' }, null).dataDir, '/x/ora');
});

test('a config file overrides defaults and env overrides the file', () => {
  const file = JSON.stringify({ port: 9000, llamaServer: '/opt/llama-server', modelsDir: '/m' });
  const c = loadConfig({ HOME: '/h', ORA_PORT: '9100', ORA_MODELS_DIR: '/envm' }, file);
  same([c.port, c.llamaServer, c.modelsDir], [9100, '/opt/llama-server', '/envm']);
});

test('bad values in the file fall back to the default', () => {
  const c = loadConfig(HOME, JSON.stringify({ port: 'abc', modelsDir: 5, llamaServer: '' }));
  same([c.port, c.modelsDir, c.llamaServer], [8800, '/h/.config/ora/models', 'llama-server']);
});

test('llamaArgs: none by default, a list from the file, a space-separated string from the env', () => {
  same(loadConfig(HOME, null).llamaArgs, []);
  same(loadConfig(HOME, JSON.stringify({ llamaArgs: ['-ngl', '0', '--flash-attn'] })).llamaArgs, ['-ngl', '0', '--flash-attn']);
  same(loadConfig({ HOME: '/h', ORA_LLAMA_ARGS: '-ngl  20 -t 8' }, JSON.stringify({ llamaArgs: ['x'] })).llamaArgs, [
    '-ngl',
    '20',
    '-t',
    '8',
  ]);
  same(loadConfig(HOME, JSON.stringify({ llamaArgs: ['ok', 5] })).llamaArgs, []);
});

test('the default models folder sits next to the config file, wherever that is', () => {
  same(loadConfig({ HOME: '/h', XDG_CONFIG_HOME: '/xc' }, null).modelsDir, '/xc/ora/models');
  same(loadConfig({ HOME: '/h', ORA_CONFIG: '/etc/ora-a/settings.json' }, null).modelsDir, '/etc/ora-a/models');
});

test('ORA_DIST selects a directory to serve instead of the embedded assets', () => {
  same(loadConfig({ HOME: '/h', ORA_DIST: '/d' }, null).distDir, '/d');
});

test('malformed JSON is an error that names the problem', () => {
  assert.throws(() => loadConfig(HOME, '{nope'), /config/i);
});

test('config file location: ORA_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
  same(configPath({ HOME: '/h', ORA_CONFIG: '/c.json' }), '/c.json');
  same(configPath({ HOME: '/h', XDG_CONFIG_HOME: '/xc' }), '/xc/ora/config.json');
  same(configPath(HOME), '/h/.config/ora/config.json');
});

test('Windows has no HOME: USERPROFILE stands in for it', () => {
  same(loadConfig({ USERPROFILE: '/u' }, null).dataDir, '/u/.local/share/ora');
  same(configPath({ USERPROFILE: '/u' }), '/u/.config/ora/config.json');
});
