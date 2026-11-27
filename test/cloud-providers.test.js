'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  PROVIDER_IDS,
  resolveBinary,
  detectProvider,
  detectCloudProviders,
  discoverProviderModels,
  providerEnvironment,
  readCodexSnapshot,
  runCloudProvider
} = require('../src/cloud-providers');
const { WORK_DIR } = require('../src/claude');

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdinData = '';
    child.stdin.on('data', (d) => { child.stdinData += d; });
    calls.push({ bin, args, opts, child });
    behave(child, calls[calls.length - 1]);
    return child;
  };
  return { spawn, calls };
}

function makeTempHome(t, prefix = 'cp-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function probeOutput(args) {
  if (args[0] === '--version') return '1.16.1';
  if (args[0] === 'usage') return '{"subscriptionActive":true,"allowance":null}';
  if (args[0] === 'models') return 'gemini-3.8-flash-medium    Gemini Flash\n';
  if (args[0] === 'status') return 'Logged in to Cursor';
  if (args[0] === 'auth') return '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';
  return '';
}

function runConfig(t) {
  const home = makeTempHome(t);
  const probe = fakeSpawn((child, call) => {
    child.stdin.on('finish', () => {
      child.stdout.write(probeOutput(call.args));
      child.emit('close', 0);
    });
  });
  writeJson(path.join(home, '.codex', 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: 'fixture' } });
  writeJson(path.join(home, '.local', 'share', 'opencode', 'auth.json'), {
    anthropic: { type: 'oauth', access: 'fixture' },
    openai: { type: 'api', key: 'fixture' }
  });
  writeJson(path.join(home, '.gemini', 'settings.json'), { security: { auth: { selectedType: 'oauth-personal' } } });
  writeJson(path.join(home, '.gemini', 'oauth_creds.json'), { refresh_token: 'fixture' });
  return {
    homedir: () => home,
    env: {
      ANTHROPIC_API_KEY: 'test', CURSOR_API_KEY: 'test', META_API_KEY: 'test', OPENCODE_AUTH_CONTENT: 'test', GOOGLE_CLOUD_PROJECT: 'code-assist-fixture'
    },
    resolve: (bin) => ({ command: `/bin/${bin}`, prefix: [], path: `/bin/${bin}` }),
    probeSpawn: probe.spawn
  };
}

test('resolveBinary handles Windows .exe, .cmd->node+.js, .cmd->.ps1, and POSIX paths', (t) => {
  const tmp = makeTempHome(t, 'cp-bin-');

  // Windows .exe
  const exePath = path.join(tmp, 'tool.exe');
  assert.deepEqual(
    resolveBinary('tool', {
      platform: 'win32',
      exec: () => `${exePath}\r\n`,
      homedir: () => tmp,
      env: {}
    }),
    { command: exePath, prefix: [], path: exePath }
  );

  // Windows .cmd wrapping node + .js
  const npmDir = path.join(tmp, 'npm');
  const jsTarget = path.join(npmDir, 'node_modules', 'pkg', 'bin', 'cli.js');
  const cmdJs = path.join(npmDir, 'codex.cmd');
  writeText(jsTarget, '// cli');
  writeText(cmdJs, '@ECHO off\r\n"%~dp0%\\node_modules\\pkg\\bin\\cli.js" %*\r\n');
  assert.deepEqual(
    resolveBinary('codex', {
      platform: 'win32',
      exec: () => `${path.join(npmDir, 'codex')}\r\n${cmdJs}\r\n`,
      homedir: () => tmp,
      env: {}
    }),
    { command: 'node', prefix: [jsTarget], path: cmdJs }
  );

  // Windows .cmd wrapping .ps1
  const psDir = path.join(tmp, 'ps');
  const psTarget = path.join(psDir, 'agy.ps1');
  const cmdPs = path.join(psDir, 'agy.cmd');
  writeText(psTarget, '# ps1');
  writeText(cmdPs, '@echo off\r\npowershell -ExecutionPolicy Bypass -File "%~dp0\\agy.ps1" %*\r\n');
  assert.deepEqual(
    resolveBinary('agy', {
      platform: 'win32',
      exec: () => `${cmdPs}\r\n`,
      homedir: () => tmp,
      env: {}
    }),
    {
      command: 'powershell.exe',
      prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psTarget],
      path: cmdPs
    }
  );

  // POSIX path
  assert.deepEqual(
    resolveBinary('codex', {
      platform: 'linux',
      exec: () => '/usr/local/bin/codex\n',
      homedir: () => tmp,
      env: {}
    }),
    { command: '/usr/local/bin/codex', prefix: [], path: '/usr/local/bin/codex' }
  );

  // Missing binary returns null
  assert.equal(
    resolveBinary('missing', {
      platform: 'linux',
      exec: () => { throw new Error('not found'); },
      homedir: () => tmp,
      env: {}
    }),
    null
  );
});

test('detectCloudProviders reports missing for all 7 providers when binaries are absent', (t) => {
  const home = makeTempHome(t);
  const res = detectCloudProviders({
    homedir: () => home,
    env: {},
    resolve: () => null
  });
  assert.deepEqual(res.map((p) => p.id), PROVIDER_IDS);
  assert.equal(res.length, 7);
  for (const p of res) {
    assert.equal(p.installed, false);
    assert.equal(p.connected, false);
    assert.equal(p.status, 'missing');
  }
});

test('detectCloudProviders reports signed-out for all 7 providers when installed without credentials', (t) => {
  const home = makeTempHome(t);
  const res = detectCloudProviders({
    homedir: () => home,
    env: {
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      ANTIGRAVITY_HOME: path.join(home, '.gemini', 'antigravity'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      APPDATA: path.join(home, 'AppData', 'Roaming')
    },
    resolve: (bin) => ({ command: `/bin/${bin}`, prefix: [], path: `/bin/${bin}` }),
    exec: () => ''
  });
  assert.equal(res.length, 7);
  for (const p of res) {
    assert.equal(p.installed, true);
    assert.equal(p.connected, false);
    assert.equal(p.status, 'signed-out');
  }
});

test('detectCloudProviders detects connected state across all 7 providers and expired Claude', (t) => {
  const home = makeTempHome(t);
  const now = 1_750_000_000_000;
  const env = {
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    ANTIGRAVITY_HOME: path.join(home, '.gemini', 'antigravity'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    GOOGLE_CLOUD_PROJECT: 'code-assist-fixture'
  };

  // Claude connected
  writeJson(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
    claudeAiOauth: { accessToken: 'tok-live', expiresAt: now + 3600_000, subscriptionType: 'max_5x' }
  });
  // Codex connected + rollout plan_type
  writeJson(path.join(env.CODEX_HOME, 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'codex-tok' }
  });
  writeText(
    path.join(env.CODEX_HOME, 'sessions', '2026', '03', 'rollout-1.jsonl'),
    JSON.stringify({ payload: { rate_limits: { plan_type: 'pro' } } }) + '\n'
  );
  // Muse connected
  writeJson(path.join(env.XDG_CONFIG_HOME, 'muse', 'auth.json'), { providers: { meta: { oauth: { access: 'm' } } } });
  // Antigravity connected
  writeText(path.join(env.ANTIGRAVITY_HOME, 'antigravity_state.pbtxt'), 'signed_in: true\n');
  // OpenCode connected (OAuth)
  writeJson(path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), {
    anthropic: { type: 'oauth', access: 'oc' },
    openai: { type: 'api', key: 'sk-test' }
  });
  // Cursor connected
  writeJson(path.join(home, '.cursor', 'auth.json'), { token: 'cur' });
  // Gemini connected
  writeJson(path.join(home, '.gemini', 'settings.json'), { security: { auth: { selectedType: 'oauth-personal' } } });
  writeJson(path.join(home, '.gemini', 'oauth_creds.json'), { access_token: 'gem' });

  const resolve = (bin) => ({ command: `/bin/${bin}`, prefix: [], path: `/bin/${bin}` });
  const connected = detectCloudProviders({ homedir: () => home, env, now, resolve, exec: (_cmd, args) => probeOutput(args) });
  const byId = Object.fromEntries(connected.map((p) => [p.id, p]));

  for (const id of PROVIDER_IDS) {
    assert.equal(byId[id].installed, true, id);
    assert.equal(byId[id].connected, true, id);
    assert.equal(byId[id].status, 'connected', id);
  }
  assert.equal(byId.claude.planLabel, 'Max 5x');
  assert.equal(byId.codex.planLabel, 'ChatGPT Pro');
  assert.equal(byId.muse.planLabel, '');
  assert.equal(byId.antigravity.planLabel, 'Antigravity');
  assert.equal(byId.opencode.planLabel, 'Anthropic');
  assert.deepEqual(byId.opencode.oauthProviders, ['anthropic']);
  assert.equal(byId.cursor.planLabel, 'Cursor');
  assert.equal(byId.gemini.planLabel, 'Gemini Code Assist');

  // Claude expired
  writeJson(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
    claudeAiOauth: { accessToken: 'tok-old', expiresAt: now - 1000, subscriptionType: 'pro' }
  });
  const expiredClaude = detectProvider('claude', { homedir: () => home, env, now, resolve, exec: () => '' });
  assert.equal(expiredClaude.installed, true);
  assert.equal(expiredClaude.connected, false);
  assert.equal(expiredClaude.status, 'expired');
  assert.equal(expiredClaude.planLabel, 'Pro');
});

test('detectProvider rejects Codex OPENAI_API_KEY-only auth and OpenCode API-key-only auth', (t) => {
  const home = makeTempHome(t);
  const env = {
    CODEX_HOME: path.join(home, '.codex'),
    XDG_DATA_HOME: path.join(home, '.local', 'share')
  };
  const resolve = (bin) => ({ command: `/bin/${bin}`, prefix: [], path: `/bin/${bin}` });

  writeJson(path.join(env.CODEX_HOME, 'auth.json'), { OPENAI_API_KEY: 'sk-only' });
  const codex = detectProvider('codex', { homedir: () => home, env, resolve, exec: () => '' });
  assert.equal(codex.connected, false);
  assert.equal(codex.status, 'signed-out');
  assert.match(codex.reason, /API key/i);

  writeJson(path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), {
    openai: { type: 'api', key: 'sk-only' }
  });
  const opencode = detectProvider('opencode', { homedir: () => home, env, resolve, exec: (_command, args) => probeOutput(args) });
  assert.equal(opencode.connected, false);
  assert.equal(opencode.status, 'signed-out');
  assert.match(opencode.reason, /API keys/i);
});

test('OpenCode V2 trusts the current OAuth connection and never falls back to a migrated V1 login', (t) => {
  const opts = runConfig(t);
  const oauth = { type: 'credential', method: 'oauth' };
  const key = { type: 'credential', method: 'key' };
  const accounts = (connections) => detectProvider('opencode', { ...opts, exec: (_command, args) => {
    if (args[0] === '--version') return '2.1.5';
    return JSON.stringify([{ id: 'anthropic', connections }]);
  } });
  assert.equal(accounts([key, oauth]).connected, false);
  assert.equal(accounts([{ ...oauth, status: { status: 'needs_auth' } }, oauth]).connected, false);
  assert.equal(accounts([]).connected, false);
  assert.deepEqual(accounts([oauth, key]).oauthProviders, ['anthropic']);
});

test('browser authentication is rechecked before any prompt and inherited metered overrides are removed', async (t) => {
  const options = runConfig(t);
  const spawn = () => { assert.fail('the report process must not start'); };
  for (const [provider, model] of [['opencode', 'openai/gpt-5'], ['claude', 'haiku'], ['cursor', 'default']]) {
    const probe = fakeSpawn((child, call) => {
      child.stdin.on('finish', () => {
        const data = call.args[0] === '--version' ? '1.16.1' : call.args[0] === 'auth'
          ? '{"loggedIn":true,"authMethod":"api-key","apiProvider":"firstParty"}'
          : 'Not logged in';
        child.stdout.write(data);
        child.emit('close', 0);
      });
    });
    await assert.rejects(runCloudProvider({ ...options, provider, model, prompt: 'report evidence', spawn, probeSpawn: probe.spawn }),
      /signed-in OAuth|Not signed in/);
    assert.ok(probe.calls.every((call) => !call.child.stdinData && !call.args.includes('report evidence')));
  }

  const env = providerEnvironment('opencode', {
    OPENAI_API_KEY: 'value', lower_api_key: 'value', META_API_KEY: 'value', OPENCODE_AUTH_CONTENT: 'value',
    GEMINI_CLI_USE_COMPUTE_ADC: 'value', ANTHROPIC_BASE_URL: 'value', CODEX_HOME: 'keep', Path: 'keep'
  });
  assert.deepEqual(env, { CODEX_HOME: 'keep', Path: 'keep', OPENCODE_PERMISSION: '{"*":"deny","read":"allow"}' });
});

test('Codex reads account quota and found models over the no-turn app-server protocol', async (t) => {
  const options = runConfig(t);
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const methods = [];
  const { spawn } = fakeSpawn((child) => {
    child.stdin.on('data', (line) => {
      const request = JSON.parse(line);
      methods.push(request.method);
      const replies = {
        0: {},
        1: { account: { type: 'chatgpt', planType: 'plus', email: 'private@example.invalid' } },
        2: {
          rateLimits: { limitId: 'codex_other', primary: { windowDurationMins: 300, usedPercent: 99, resetsAt: reset } },
          rateLimitsByLimitId: { codex: {
            limitId: 'codex',
            primary: { windowDurationMins: 300, usedPercent: 21, resetsAt: reset },
            secondary: { windowDurationMins: 1440, usedPercent: 30, resetsAt: reset }
          } }
        },
        3: { data: [{
          model: 'gpt-test', displayName: 'GPT Test', contextWindow: 123456,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low'
        }, { model: 'hidden', hidden: true }] }
      };
      if (request.id != null) setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, result: replies[request.id] }) + '\n'));
    });
  });
  const snapshot = await readCodexSnapshot({ ...options, spawn });
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'model/list']);
  assert.equal(snapshot.planLabel, 'ChatGPT Plus');
  assert.equal(snapshot.live.fiveHour.pct, 21);
  assert.equal(snapshot.live.sevenDay, undefined);
  assert.deepEqual(snapshot.models, [{ id: 'gpt-test', label: 'GPT Test', context: 123456, efforts: ['low'], defaultEffort: 'low' }]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private/);
});

test('discoverProviderModels parses codex config.toml, muse, agy, and OAuth-filtered opencode models', (t) => {
  const home = makeTempHome(t);
  const env = {
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config')
  };
  const resolve = (bin) => ({ command: `/bin/${bin}`, prefix: [], path: `/bin/${bin}` });

  writeText(path.join(env.CODEX_HOME, 'config.toml'), 'model = "gpt-5.4-pro"\nmodel_reasoning_effort = "high"\n');
  const codexModels = discoverProviderModels('codex', { homedir: () => home, env });
  assert.equal(codexModels[0].id, 'gpt-5.4-pro');
  assert.match(codexModels[0].label, /\(configured\)/);
  assert.equal(codexModels.length, 1);

  writeJson(path.join(env.XDG_CONFIG_HOME, 'muse', 'settings.json'), { model: 'muse-wonder-1.0' });
  const museModels = discoverProviderModels('muse', {
    homedir: () => home,
    env,
    resolve,
    exec: (cmd, args) => {
      assert.deepEqual(args, ['exec', '--list-models']);
      return 'muse-spark-1.3\nmuse-ember-1.0\n';
    }
  });
  assert.deepEqual(
    museModels.map((m) => m.id),
    ['muse-spark-1.3', 'muse-ember-1.0']
  );

  const agyModels = discoverProviderModels('antigravity', {
    homedir: () => home,
    resolve,
    exec: (cmd, args) => {
      assert.deepEqual(args, ['models']);
      return 'gemini-3.8-flash-medium\tGemini 3.8 Flash\nclaude-opus-4\tClaude Opus 4\n';
    }
  });
  assert.deepEqual(agyModels, [
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash', tier: 'fast', context: 200000, efforts: [] },
    { id: 'claude-opus-4', label: 'Claude Opus 4', tier: 'strong', context: 200000 }
  ]);

  const opencodeModels = discoverProviderModels('opencode', {
    homedir: () => home,
    resolve,
    detected: { oauthProviders: ['anthropic'] },
    exec: (cmd, args) => {
      assert.deepEqual(args, ['models']);
      return 'anthropic/claude-sonnet-4\nopenai/gpt-5\nanthropic/claude-haiku-4\n';
    }
  });
  assert.deepEqual(
    opencodeModels.map((m) => m.id),
    ['anthropic/claude-sonnet-4', 'anthropic/claude-haiku-4']
  );
});

test('runCloudProvider handles codex, muse, antigravity, opencode, cursor, and gemini with temp cleanup', async (t) => {
  const config = runConfig(t);
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const snapshotWorkDir = () => (fs.existsSync(WORK_DIR) ? fs.readdirSync(WORK_DIR) : []);
  const beforeFiles = new Set(snapshotWorkDir());

  // 1. Codex: stdin + temp schema file + JSONL parsing + usage
  {
    let seenSchemaPath = '';
    let seenSchemaBody = '';
    let usageCall = null;
    const { spawn, calls } = fakeSpawn((c, call) => {
      const idx = call.args.indexOf('--output-schema');
      seenSchemaPath = call.args[idx + 1];
      seenSchemaBody = fs.readFileSync(seenSchemaPath, 'utf8');
      c.stdin.on('finish', () => {
        c.stdout.write([
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 15 } })
        ].join('\n'));
        c.emit('close', 0);
      });
    });
    const out = await runCloudProvider({
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      prompt: 'codex prompt',
      schema,
      spawn,
      ...config,
      onTokenUsage: (totalIn, u) => { usageCall = { totalIn, u }; }
    });
    assert.equal(out, '{"ok":true}');
    assert.equal(calls[0].child.stdinData, 'codex prompt');
    assert.ok(calls[0].args.includes('--ephemeral'));
    assert.ok(calls[0].args.includes('-m'));
    assert.equal(seenSchemaBody, JSON.stringify(schema));
    assert.equal(fs.existsSync(seenSchemaPath), false, 'codex schema temp file must be removed');
    assert.deepEqual(usageCall, {
      totalIn: 100,
      u: { input: 80, output: 15, cacheRead: 20, cacheCreate: 0, totalInput: 100 }
    });
  }

  // 2. Muse: temp prompt file + temp schema file, no stdin
  {
    let promptPath = '';
    let schemaPath = '';
    let promptBody = '';
    let usageCall = null;
    const { spawn, calls } = fakeSpawn((c, call) => {
      promptPath = call.args[call.args.indexOf('--prompt-file') + 1];
      schemaPath = call.args[call.args.indexOf('--output-schema') + 1];
      promptBody = fs.readFileSync(promptPath, 'utf8');
      c.stdin.on('finish', () => {
        c.stdout.write([
          { type: 'run.output.delta', payload: { text: 'muse ' } },
          { type: 'run.output.delta', payload: { text: 'ok' } },
          { type: 'run.terminal.completed', payload: { text: 'muse ok', terminal: 'completed' } },
          { type: 'run.usage', payload: { models: { test: { input_tokens: 50, output_tokens: 10 } } } }
        ].map((event) => JSON.stringify(event)).join('\n'));
        c.emit('close', 0);
      });
    });
    const out = await runCloudProvider({
      provider: 'muse',
      model: 'muse-spark-1.3',
      effort: 'medium',
      prompt: 'muse prompt',
      schema,
      spawn,
      ...config,
      onTokenUsage: (totalIn, u) => { usageCall = { totalIn, u }; }
    });
    assert.equal(out, 'muse ok');
    assert.equal(promptBody, 'muse prompt');
    assert.equal(calls[0].child.stdinData, '');
    assert.equal(fs.existsSync(promptPath), false, 'muse prompt temp file must be removed');
    assert.equal(fs.existsSync(schemaPath), false, 'muse schema temp file must be removed');
    assert.equal(usageCall.totalIn, 50);
  }

  // 3. Antigravity: stdin + temp schema file + JSON envelope
  {
    let schemaPath = '';
    let usageCall = null;
    const { spawn, calls } = fakeSpawn((c, call) => {
      schemaPath = call.args[call.args.indexOf('--json-schema') + 1];
      c.stdin.on('finish', () => {
        c.stdout.write(`${JSON.stringify({ event: 'init', init: { model: 'gemini-3.8-flash-medium' } })}
`);
        c.stdout.write(`${JSON.stringify({ event: 'result', result: {
          status: 'SUCCESS', structured_output: { ok: true },
          usage: { input_tokens: 80, output_tokens: 20 }
        } })}
`);
        c.emit('close', 0);
      });
    });
    const out = await runCloudProvider({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-medium',
      effort: 'low',
      prompt: 'agy prompt',
      schema,
      spawn,
      ...config,
      onTokenUsage: (totalIn) => { usageCall = totalIn; }
    });
    assert.deepEqual(JSON.parse(out), { ok: true });
    assert.equal(calls[0].child.stdinData, `${JSON.stringify({ event: 'user', message: { content: 'agy prompt' } })}
`);
    assert.ok(!calls[0].args.includes('-p'), 'agy would take the next flag as the prompt');
    assert.deepEqual(calls[0].args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
    assert.ok(!calls[0].args.includes('--effort'), 'the selected Antigravity model slug already pins its effort');
    assert.equal(fs.existsSync(schemaPath), false, 'antigravity schema temp file must be removed');
    assert.equal(usageCall, 80);
  }

  // 4. OpenCode: stdin, JSONL text + step_finish
  {
    let usageCall = null;
    const { spawn, calls } = fakeSpawn((c) => {
      c.stdin.on('finish', () => {
        c.stdout.write([
          JSON.stringify({ type: 'text', part: { text: 'hello ' } }),
          JSON.stringify({ type: 'text', part: { text: 'world' } }),
          JSON.stringify({ type: 'step_finish', part: { tokens: { input: 40, output: 12, cache: { read: 8, write: 2 } } } })
        ].join('\n'));
        c.emit('close', 0);
      });
    });
    const out = await runCloudProvider({
      provider: 'opencode',
      model: 'anthropic/claude-sonnet-4',
      effort: 'high',
      prompt: 'opencode prompt',
      spawn,
      ...config,
      onTokenUsage: (totalIn, u) => { usageCall = { totalIn, u }; }
    });
    assert.equal(out, 'hello world');
    assert.equal(calls[0].child.stdinData, 'opencode prompt');
    assert.ok(calls[0].args.includes('--variant'));
    assert.equal(usageCall.totalIn, 50);
  }

  // 5. Cursor: private prompt file and native CLI defaults
  {
    const { spawn, calls } = fakeSpawn((c, call) => {
      assert.equal(fs.readFileSync(path.join(call.opts.cwd, 'prompt.txt'), 'utf8'), 'cursor prompt');
      assert.equal(call.opts.env.CURSOR_API_KEY, undefined);
      c.stdin.on('finish', () => {
        c.stdout.write(JSON.stringify({ result: 'cursor ok', usage: { prompt_tokens: 30, completion_tokens: 9 } }));
        c.emit('close', 0);
      });
    });
    const out = await runCloudProvider({
      provider: 'cursor',
      model: 'default',
      prompt: 'cursor prompt',
      spawn,
      ...config
    });
    assert.equal(out, 'cursor ok');
    assert.ok(!calls[0].args.includes('--model'));
    assert.equal(calls[0].child.stdinData, '');
    assert.equal(fs.existsSync(path.join(calls[0].opts.cwd, 'prompt.txt')), false);
  }

  // 6. Gemini: stdin + stats.models token extraction
  {
    let usageCall = null;
    const { spawn, calls } = fakeSpawn((c) => {
      c.stdin.on('finish', () => {
        c.stdout.write(JSON.stringify({
          response: 'gemini ok',
          stats: { models: { 'gemini-2.5-pro': { tokens: { promptTokenCount: 90, candidatesTokenCount: 25 } } } }
        }));
        c.emit('close', 0);
      });
    });
    const out = await runCloudProvider({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      prompt: 'gemini prompt',
      spawn,
      ...config,
      onTokenUsage: (totalIn) => { usageCall = totalIn; }
    });
    assert.equal(out, 'gemini ok');
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'gemini-2.5-pro');
    assert.equal(calls[0].child.stdinData, 'gemini prompt');
    assert.equal(usageCall, 90);
  }

  const afterFiles = snapshotWorkDir().filter((f) => !beforeFiles.has(f));
  assert.deepEqual(afterFiles, [], 'no temp files left behind in WORK_DIR');
});

test('runCloudProvider handles non-zero exit, timeout, and AbortSignal cancellation with temp cleanup', async (t) => {
  const config = runConfig(t);
  const snapshotWorkDir = () => (fs.existsSync(WORK_DIR) ? fs.readdirSync(WORK_DIR) : []);
  const beforeFiles = new Set(snapshotWorkDir());

  // Non-zero exit cleans up temp files
  {
    let promptPath = '';
    const { spawn } = fakeSpawn((c, call) => {
      promptPath = call.args[call.args.indexOf('--prompt-file') + 1];
      setImmediate(() => {
        c.stderr.write('boom failure');
        setImmediate(() => c.emit('close', 3));
      });
    });
    await assert.rejects(
      runCloudProvider({ provider: 'muse', model: 'muse-spark-1.3', prompt: 'p', spawn, ...config }),
      /code 3/
    );
    assert.equal(fs.existsSync(promptPath), false);
  }

  // Timeout kills child and cleans up temp files
  {
    const { spawn, calls } = fakeSpawn(() => {});
    await assert.rejects(
      runCloudProvider({ provider: 'opencode', model: 'anthropic/claude-sonnet-4', prompt: 'p', timeoutMs: 20, spawn, ...config }),
      /timed out/
    );
    assert.equal(calls[0].child.killed, true);
    assert.equal(fs.existsSync(calls[0].opts.cwd), false);
  }

  // AbortSignal mid-flight kills child, rejects with AbortError, cleans up temp files; pre-aborted skips spawn
  {
    let promptPath = '';
    const controller = new AbortController();
    const { spawn, calls } = fakeSpawn((_c, call) => {
      promptPath = call.args[call.args.indexOf('--prompt-file') + 1];
    });
    const opts = { provider: 'muse', model: 'muse-spark-1.3', prompt: 'p', signal: controller.signal, spawn, ...config };
    const p = runCloudProvider(opts);
    await new Promise(setImmediate);
    controller.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(calls[0].child.killed, true);
    assert.equal(fs.existsSync(promptPath), false);

    await assert.rejects(runCloudProvider(opts), { name: 'AbortError' });
    assert.equal(calls.length, 1);
  }

  const afterFiles = snapshotWorkDir().filter((f) => !beforeFiles.has(f));
  assert.deepEqual(afterFiles, [], 'no temp files left behind after errors');
});

test('Gemini ids are not mistaken for mini models', () => {
  const { discoverProviderModels: discover } = require('../src/cloud-providers');
  const models = discover('antigravity', {
    homedir: () => os.tmpdir(),
    resolve: (bin) => ({ command: `/bin/${bin}`, prefix: [], path: `/bin/${bin}` }),
    exec: () => 'gemini-4-neon-high\tNeon\ngemini-4-carbon-medium\tCarbon\ngemini-3.8-flash-medium\tFlash\ngpt-5-mini\tMini\n'
  });
  assert.deepEqual(models.map((m) => [m.id, m.tier]), [
    ['gemini-4-neon-high', 'strong'], ['gemini-4-carbon-medium', 'balanced'],
    ['gemini-3.8-flash-medium', 'fast'], ['gpt-5-mini', 'fast']
  ]);
});

test('provider failures carry the CLI reason, such as a usage limit', () => {
  const { parseJsonlEvents: jsonl, parseEnvelopeOutput: envelope } = require('../src/cloud-providers');
  const limit = 'You have hit your usage limit. Try again at 4:25 PM.';
  assert.throws(() => jsonl([
    JSON.stringify({ type: 'error', message: limit }),
    JSON.stringify({ type: 'turn.failed', error: { message: limit } })
  ].join('\n'), 'codex'), { message: limit });
  assert.throws(() => envelope(JSON.stringify({ status: 'ERROR', error: 'Individual quota reached.' })), { message: 'Individual quota reached.' });
});
