'use strict';

// Discovers and runs signed-in subscription CLI hooks for Cloud reports.
// Strictly uses existing OAuth/subscription logins — never asks for or accepts API keys.
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInterface } = require('readline');
const { WORK_DIR, MODELS } = require('./claude');

const PROVIDER_IDS = ['claude', 'codex', 'muse', 'antigravity', 'opencode', 'cursor', 'gemini'];

const PROVIDERS = {
  claude: { id: 'claude', label: 'Claude Code', bin: 'claude', supportsEffort: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultContext: 200000, loginCmd: 'claude auth login --claudeai' },
  codex: { id: 'codex', label: 'Codex', bin: 'codex', supportsEffort: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultContext: 200000, loginCmd: 'codex login' },
  muse: { id: 'muse', label: 'Muse', bin: 'muse', supportsEffort: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultContext: 200000, loginCmd: 'muse login' },
  antigravity: { id: 'antigravity', label: 'Antigravity', bin: 'agy', supportsEffort: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultContext: 200000, loginCmd: 'agy' },
  opencode: { id: 'opencode', label: 'OpenCode', bin: 'opencode', supportsEffort: true, efforts: ['low', 'medium', 'high'], defaultContext: 200000, loginUrl: 'https://opencode.ai/docs/cli/providers/' },
  cursor: { id: 'cursor', label: 'Cursor CLI', bin: 'cursor-agent', supportsEffort: false, efforts: [], defaultContext: 200000, loginCmd: 'cursor-agent login' },
  gemini: { id: 'gemini', label: 'Gemini CLI', bin: 'gemini', supportsEffort: false, efforts: [], defaultContext: 200000, loginCmd: 'gemini' }
};

const LOGIN_ARGS = {
  claude: ['auth', 'login', '--claudeai'],
  codex: ['login'],
  muse: ['login'],
  antigravity: [],
  cursor: ['login'],
  gemini: []
};

// Do not allow the editor's environment to switch the CLI to a metered account,
// proxy or an external credential source. The CLI still owns its browser login.
function providerEnvironment(provider, env = process.env) {
  const drop = /(?:^|_)(?:API_?KEY|BASE_URL|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|API_TOKEN)(?:$|_)/i;
  const overrides = /^(?:CODEX_CI|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GEMINI_CLI_USE_COMPUTE_ADC|GOOGLE_GENAI_USE_VERTEXAI|OPENCODE_AUTH_CONTENT|OPENCODE_CONFIG(?:_CONTENT|_DIR)?|OPENAI_ORG_ID|OPENAI_PROJECT_ID|MODEL_API_KEY|GITHUB_TOKEN|GH_TOKEN)$/i;
  const result = Object.fromEntries(Object.entries(env).filter(([name]) => !drop.test(name) && !overrides.test(name)));
  if (provider === 'claude') result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (provider === 'muse') result.MUSE_NO_AUTO_UPDATE = '1';
  if (provider === 'opencode') {
    result.OPENCODE_PERMISSION = '{"*":"deny","read":"allow"}';
  }
  return result;
}

function readJsonSafe(file, read = (p) => fs.readFileSync(p, 'utf8')) {
  try { return JSON.parse(read(file)); } catch { return null; }
}

function readTextSafe(file, read = (p) => fs.readFileSync(p, 'utf8')) {
  try { return read(file); } catch { return null; }
}

function extraCandidates(name, { env = process.env, homedir = os.homedir, platform = process.platform } = {}) {
  const home = homedir();
  const ext = platform === 'win32' ? '.exe' : '';
  const list = [];
  if (name === 'agy') list.push(path.join(home, '.gemini', 'bin', 'agy' + ext));
  if (name === 'muse' && platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const dir = env.MUSE_INSTALL_DIR || path.join(local, 'Programs', 'muse');
    list.push(path.join(dir, 'muse.cmd'), path.join(dir, 'muse.exe'));
  }
  if (name === 'claude') list.push(path.join(home, '.local', 'bin', 'claude' + ext));
  if (name === 'muse' && platform !== 'win32') list.push(path.join(home, '.local', 'bin', name));
  if (name === 'cursor-agent' || name === 'agent') {
    list.push(path.join(home, '.local', 'bin', name + ext));
    if (platform === 'win32') {
      const dir = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cursor-agent');
      list.push(...['.exe', '.ps1', '.cmd'].map((suffix) => path.join(dir, name + suffix)));
    }
  }
  return list;
}

function resolveWindowsShim(shimPath, { exists = fs.existsSync, read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const dir = path.dirname(shimPath);
  const body = readTextSafe(shimPath, read) || '';
  const exeMatch = /"%~?dp0%?[\\/]?([^"%\s]+\.exe)"/i.exec(body) || /node_modules[\\/]+([^"%\s]+\.exe)/i.exec(body);
  if (exeMatch) {
    const rel = exeMatch[0].includes('node_modules') && !exeMatch[1].startsWith('node_modules')
      ? path.join(dir, 'node_modules', exeMatch[1])
      : path.join(dir, exeMatch[1]);
    if (exists(rel)) return { command: rel, prefix: [], path: shimPath };
  }
  const jsMatch = /"%~?dp0%?[\\/]?([^"%\s]+\.(?:js|mjs|cjs))"/i.exec(body) || /node_modules[\\/]+([^"%\s]+\.(?:js|mjs|cjs))/i.exec(body);
  if (jsMatch) {
    const rel = jsMatch[0].includes('node_modules') && !jsMatch[1].startsWith('node_modules')
      ? path.join(dir, 'node_modules', jsMatch[1])
      : path.join(dir, jsMatch[1]);
    if (exists(rel)) return { command: 'node', prefix: [rel], path: shimPath };
  }
  const psMatch = /-File\s+"%~?dp0%?([^"]+\.ps1)"/i.exec(body);
  if (psMatch) {
    const psPath = path.join(dir, psMatch[1].replace(/^[\\/]+/, ''));
    if (exists(psPath)) {
      return { command: 'powershell.exe', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], path: shimPath };
    }
  }
  // Unknown batch files would re-interpret arguments as shell syntax.
  return null;
}

function resolveBinary(name, opts = {}) {
  const {
    platform = process.platform,
    exec = childProcess.execFileSync,
    exists = fs.existsSync,
    read = (p) => fs.readFileSync(p, 'utf8'),
    env = process.env,
    homedir = os.homedir
  } = opts;
  const found = [];
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const out = String(exec(cmd, [name], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p) found.push(p);
    }
  } catch { /* check known install locations */ }
  for (const cand of extraCandidates(name, { env, homedir, platform })) {
    if (exists(cand) && !found.includes(cand)) found.push(cand);
  }
  if (!found.length) return null;

  if (platform === 'win32') {
    const exe = found.find((p) => /\.exe$/i.test(p));
    if (exe) return { command: exe, prefix: [], path: exe };
    for (const shim of found.filter((p) => /\.(cmd|bat)$/i.test(p))) {
      const target = resolveWindowsShim(shim, { exists, read });
      if (target) return target;
    }
    const ps1 = found.find((p) => /\.ps1$/i.test(p));
    if (ps1) return { command: 'powershell.exe', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], path: ps1 };
    return null;
  }
  return { command: found[0], prefix: [], path: found[0] };
}

function formatSubscriptionTier(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/max.*20/i.test(s)) return 'Max 20x';
  if (/max.*5/i.test(s)) return 'Max 5x';
  if (/^max$/i.test(s)) return 'Max';
  if (/^pro$/i.test(s)) return 'Pro';
  if (/^plus$/i.test(s)) return 'Plus';
  if (/^team$/i.test(s)) return 'Team';
  if (/^enterprise$/i.test(s)) return 'Enterprise';
  if (/^free$/i.test(s)) return 'Free';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function readNewestCodexPlanType(sessionsDir, { readdir = fs.readdirSync, stat = fs.statSync, read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { files.push({ full, mtimeMs: stat(full).mtimeMs }); } catch { /* ignore */ }
      }
    }
  };
  walk(sessionsDir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, 3)) {
    const text = readTextSafe(f.full, read);
    if (!text) continue;
    const lines = text.trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const plan = rec?.payload?.rate_limits?.plan_type;
        if (typeof plan === 'string' && plan) return formatSubscriptionTier(plan);
      } catch { /* skip */ }
    }
  }
  return '';
}

function parseCodexConfig(text) {
  const root = (text || '').split(/^\s*\[/m, 1)[0];
  return {
    model: /^\s*model\s*=\s*["']([^"']+)["']/m.exec(root)?.[1],
    authStore: /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto)["']/m.exec(root)?.[1]
  };
}

function validModelId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._:/+-]{0,149}$/i.test(id);
}

function credentialsPresent(record, fields) {
  return fields.some((key) => typeof record?.[key] === 'string' && record[key].trim());
}

function resolveProviderBinary(spec, opts = {}) {
  const resolve = opts.resolve || resolveBinary;
  return resolve(spec.bin, opts) || (spec.id === 'cursor' ? resolve('agent', opts) : null);
}

function runCliList(bin, args, { exec = childProcess.execFileSync, provider, env = process.env, cwd = os.tmpdir() } = {}) {
  if (!bin) return '';
  try {
    return String(exec(bin.command, [...bin.prefix, ...args], {
      cwd, env: providerEnvironment(provider, env), encoding: 'utf8', timeout: 8000,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    }));
  } catch { return ''; }
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[\d;]*m/g, '');
}

function parseListedModels(raw) {
  const rows = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9._:/+-]*)(?:\s{2,}|\t+|\s+-\s+)(.*)$/i.exec(line.trim());
    if (match && (/[._:/-]/.test(match[1]) || match[1] === 'auto') && match[2].trim()) rows.push({ id: match[1], label: match[2].trim() });
    else if (validModelId(line.trim()) && /[._:/-]/.test(line.trim())) rows.push({ id: line.trim() });
  }
  return rows;
}

function openCodeMajor(output) {
  return Number(/^v?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/m.exec(stripAnsi(output).trim())?.[1]);
}

function openCodeOAuthProviders(integrations) {
  if (!Array.isArray(integrations)) return [];
  return integrations.filter((item) => {
    // OpenCode v2 lists the current connection first. Later connections can be
    // OAuth while the active one for that same model provider is a paid key.
    const active = item?.connections?.[0];
    return validModelId(item?.id) && active?.type === 'credential' && active.method === 'oauth' && !active.status;
  }).map((item) => item.id);
}

function detectProvider(id, opts = {}) {
  const {
    env = process.env,
    homedir = os.homedir,
    read = (p) => fs.readFileSync(p, 'utf8'),
    readdir = fs.readdirSync,
    stat = fs.statSync,
    now = Date.now(),
    modelCatalogs,
    detectedBin
  } = opts;
  const spec = PROVIDERS[id];
  if (!spec) return null;
  const home = homedir();
  const resolved = detectedBin || resolveProviderBinary(spec, opts);
  const installed = Boolean(resolved);
  const base = { ...spec, installed, connected: false, status: installed ? 'signed-out' : 'missing', planLabel: '', reason: '' };
  if (id === 'cursor' && resolved && /(?:^|[\\/])agent(?:\.|$)/i.test(resolved.path)) base.loginCmd = 'agent login';
  if (resolved && LOGIN_ARGS[id]) {
    base.loginLaunch = { command: resolved.command, args: [...resolved.prefix, ...LOGIN_ARGS[id]] };
  }

  if (!installed) {
    base.reason = `${spec.bin} CLI not found`;
    return base;
  }

  if (id === 'claude') {
    const credPath = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json');
    const cred = readJsonSafe(credPath, read)?.claudeAiOauth;
    const auth = readJsonSafe('', () => runCliList(resolved, ['auth', 'status', '--json'], { ...opts, provider: id }));
    const planLabel = formatSubscriptionTier(cred?.rateLimitTier && /max/i.test(cred.rateLimitTier) ? cred.rateLimitTier : auth?.subscriptionType || cred?.subscriptionType);
    if (auth?.loggedIn === true && auth.authMethod === 'claude.ai' && (!auth.apiProvider || auth.apiProvider === 'firstParty')) {
      return { ...base, connected: true, status: 'connected', planLabel: planLabel || 'Claude' };
    }
    if (!auth && credentialsPresent(cred, ['accessToken', 'refreshToken'])) {
      if (!cred.expiresAt || cred.expiresAt > now || cred.refreshToken) {
        return { ...base, connected: true, status: 'connected', planLabel: planLabel || 'Claude' };
      }
      return { ...base, status: 'expired', planLabel, reason: 'Session expired. Sign in again.' };
    }
    return { ...base, reason: 'Not signed in to Claude Code' };
  }

  if (id === 'codex') {
    const codexHome = env.CODEX_HOME || path.join(home, '.codex');
    const auth = readJsonSafe(path.join(codexHome, 'auth.json'), read);
    const storedChatgpt = (auth?.auth_mode === 'chatgpt' || (!auth?.auth_mode && !auth?.OPENAI_API_KEY))
      && credentialsPresent(auth?.tokens, ['access_token', 'refresh_token']);
    const nativeStatus = storedChatgpt ? '' : runCliList(resolved, ['login', 'status'], { ...opts, provider: id });
    if (storedChatgpt || /logged in (?:with|using) chatgpt/i.test(nativeStatus)) {
      const plan = opts.skipPlanHistory ? '' : readNewestCodexPlanType(path.join(codexHome, 'sessions'), { readdir, stat, read });
      return { ...base, connected: true, status: 'connected', planLabel: plan ? `ChatGPT ${plan}` : 'ChatGPT' };
    }
    return { ...base, reason: auth?.OPENAI_API_KEY ? 'Signed in with API key only (requires ChatGPT subscription login)' : 'Not signed in to Codex' };
  }

  if (id === 'muse') {
    const cfgDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'muse');
    const auth = readJsonSafe(path.join(cfgDir, 'auth.json'), read);
    const meta = auth?.providers?.meta || auth?.meta;
    const storedKey = credentialsPresent(auth, ['api_key', 'apiKey', 'key'])
      || credentialsPresent(meta, ['api_key', 'apiKey', 'key'])
      || ['api', 'api_key', 'api-key', 'apikey'].includes(meta?.type);
    if (storedKey) return { ...base, reason: 'Muse is configured for metered API access. Use browser sign-in in Muse.' };
    const result = readJsonSafe('', () => runCliList(resolved, ['usage', '--json'], { ...opts, provider: id }));
    if (result?.subscriptionActive === true || result?.subscription_active === true || result?.reason === 'server_sent_no_usage'
      || (result?.allowance && typeof result.allowance === 'object')) {
      return { ...base, connected: true, status: 'connected', planLabel: '' };
    }
    return { ...base, reason: 'Not signed in to Muse' };
  }

  if (id === 'antigravity') {
    const agSettings = readJsonSafe(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), read);
    const userSettings = readJsonSafe(path.join(home, '.gemini', 'config', 'config.json'), read)?.userSettings;
    if (agSettings?.modelProvider === 'gemini' || userSettings?.enableAdc) {
      return { ...base, reason: 'Antigravity is configured for Google Cloud or API access. Select a Google account subscription in Antigravity.' };
    }
    const models = parseListedModels(runCliList(resolved, ['models'], { ...opts, provider: id }));
    if (models.length) {
      modelCatalogs?.set(id, models);
      return { ...base, connected: true, status: 'connected', planLabel: 'Antigravity' };
    }
    return { ...base, reason: 'No local Antigravity login detected' };
  }

  if (id === 'opencode') {
    const run = (args) => runCliList(resolved, args, { ...opts, provider: id });
    const major = openCodeMajor(run(['--version']));
    if (major >= 2) {
      const accounts = readJsonSafe('', () => run(['auth', 'list', '--format', 'json']));
      const oauthProviders = openCodeOAuthProviders(accounts);
      if (oauthProviders.length) {
        return { ...base, connected: true, status: 'connected', planLabel: oauthProviders.map(formatSubscriptionTier).join(', '), oauthProviders, openCodeMajor: major };
      }
      return { ...base, reason: 'OpenCode needs an active OAuth connection for a report model.' };
    }
    if (major !== 1) return { ...base, reason: 'Could not verify the installed OpenCode version and active subscription.' };
    const authFile = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json');
    const auth = readJsonSafe(authFile, read);
    const oauthProviders = auth && typeof auth === 'object'
      ? Object.entries(auth).filter(([key, v]) => validModelId(key) && v?.type === 'oauth' && credentialsPresent(v, ['access', 'refresh'])).map(([k]) => k)
      : [];
    if (oauthProviders.length) {
      return { ...base, connected: true, status: 'connected', planLabel: oauthProviders.map(formatSubscriptionTier).join(', '), oauthProviders, openCodeMajor: major };
    }
    const apiCount = auth && typeof auth === 'object' ? Object.values(auth).filter((v) => v?.type === 'api').length : 0;
    return { ...base, reason: apiCount ? 'Only API keys found — OpenCode requires an OAuth subscription login' : 'Not signed in to an OpenCode subscription' };
  }

  if (id === 'cursor') {
    const status = stripAnsi(runCliList(resolved, ['status'], { ...opts, provider: id }));
    if (/\b(?:logged in|authenticated)\b/i.test(status) && !/\b(?:not (?:logged in|authenticated)|api[ -]key|signed out)\b/i.test(status)) {
      return { ...base, connected: true, status: 'connected', planLabel: 'Cursor' };
    }
    return { ...base, reason: 'Not signed in to Cursor CLI' };
  }

  if (id === 'gemini') {
    const geminiDir = path.join(env.GEMINI_CLI_HOME || home, '.gemini');
    const auth = readJsonSafe(path.join(geminiDir, 'settings.json'), read)?.security?.auth;
    const oauth = readJsonSafe(path.join(geminiDir, 'oauth_creds.json'), read);
    const cloudProject = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID;
    if (auth?.selectedType === 'oauth-personal' && !auth.useExternal && credentialsPresent(oauth, ['access_token', 'refresh_token'])) {
      if (!cloudProject?.trim()) return { ...base, reason: 'Gemini CLI requires a Google Cloud project and a Code Assist Standard or Enterprise license. Use Antigravity for personal Google accounts.' };
      return { ...base, connected: true, status: 'connected', planLabel: 'Gemini Code Assist' };
    }
    return { ...base, reason: 'Not signed in to Gemini CLI' };
  }

  return base;
}

function detectCloudProviders(opts = {}) {
  return PROVIDER_IDS.map((id) => detectProvider(id, opts));
}

function classifyTier(id) {
  const s = String(id || '').toLowerCase();
  // Match "mini" only as its own id part: every "gemini" id contains it.
  if (/haiku|(?:^|[-_./\s])mini(?:$|[-_./\s])|flash|argon|lite|small|spark/.test(s)) return 'fast';
  if (/opus|neon|pro(?!ject)|max|wonder|ultra/.test(s)) return 'strong';
  return 'balanced';
}

function antigravityModelHasFixedEffort(id) {
  return /orchestrator|-(?:low|medium|high|xhigh|max)$/i.test(id);
}

function normalizeModels(rows, providerId) {
  const found = new Map();
  const spec = PROVIDERS[providerId];
  for (const row of rows) {
    if (!validModelId(row.id) || found.has(row.id)) continue;
    const context = Number(row.context);
    found.set(row.id, {
      id: row.id, label: row.label || row.id, tier: classifyTier(row.id),
      context: Number.isSafeInteger(context) && context > 0 ? context : spec.defaultContext,
      ...(row.efforts ? { efforts: row.efforts.filter((effort) => spec.efforts.includes(effort)) } : {}),
      ...(spec.efforts.includes(row.defaultEffort) ? { defaultEffort: row.defaultEffort } : {})
    });
  }
  return [...found.values()];
}

function discoverProviderModels(providerId, opts = {}) {
  const {
    env = process.env,
    homedir = os.homedir,
    read = (p) => fs.readFileSync(p, 'utf8'),
    detected = null,
    modelCatalogs
  } = opts;
  const spec = PROVIDERS[providerId];
  if (!spec) return [];
  const home = homedir();
  const nativeList = (args) => runCliList(resolveProviderBinary(spec, opts), args, { ...opts, provider: providerId });
  const discovered = modelCatalogs?.get(providerId);

  if (providerId === 'claude') {
    return [
      { id: 'haiku', label: 'Haiku', tier: 'fast', context: 200000 },
      { id: 'sonnet', label: 'Sonnet', tier: 'balanced', context: 200000 },
      { id: 'opus', label: 'Opus', tier: 'strong', context: 200000 }
    ];
  }

  if (providerId === 'codex') {
    const codexDir = env.CODEX_HOME || path.join(home, '.codex');
    const cfg = parseCodexConfig(readTextSafe(path.join(codexDir, 'config.toml'), read));
    const cache = readJsonSafe(path.join(codexDir, 'models_cache.json'), read)?.models;
    const rows = discovered?.length ? discovered : Array.isArray(cache) ? cache.filter((m) => m?.visibility === 'list').map((m) => ({
      id: m.slug, label: m.display_name, context: m.context_window,
      efforts: m.supported_reasoning_levels?.map((e) => e.effort), defaultEffort: m.default_reasoning_level
    })) : [];
    if (!rows.length && cfg.model) rows.push({ id: cfg.model, label: `${cfg.model} (configured)` });
    const models = normalizeModels(rows, providerId);
    return models.length ? models : normalizeModels([{ id: 'default', label: 'CLI default' }], providerId);
  }

  if (providerId === 'muse') {
    const cfgDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'muse');
    const configured = readJsonSafe(path.join(cfgDir, 'settings.json'), read)?.model || '';
    const rows = parseListedModels(nativeList(['exec', '--list-models']));
    if (!rows.length && configured) rows.push({ id: configured, label: `${configured} (configured)` });
    const models = normalizeModels(rows, providerId);
    return models.length ? models : normalizeModels([{ id: 'default', label: 'CLI default' }], providerId);
  }

  if (providerId === 'antigravity') {
    const rows = discovered || parseListedModels(nativeList(['models']));
    return normalizeModels(rows.map((m) => antigravityModelHasFixedEffort(m.id) ? { ...m, efforts: [] } : m), providerId);
  }

  if (providerId === 'opencode') {
    const allowed = new Set(detected?.oauthProviders || []);
    if (!allowed.size) return [];
    const ids = stripAnsi(nativeList(['models'])).split(/\r?\n/).map((s) => s.trim()).filter((s) => s.includes('/') && allowed.has(s.split('/')[0]));
    return normalizeModels(ids.map((id) => ({ id })), providerId);
  }

  if (providerId === 'cursor') {
    const models = normalizeModels(parseListedModels(nativeList(['models'])), providerId);
    return models.length ? models : normalizeModels([{ id: 'default', label: 'CLI default' }], providerId);
  }

  if (providerId === 'gemini') {
    const configured = readJsonSafe(path.join(env.GEMINI_CLI_HOME || home, '.gemini', 'settings.json'), read)?.model?.name;
    return normalizeModels([{ id: configured }, { id: 'default', label: 'CLI default' }], providerId);
  }

  return [];
}

function defaultCloudModels(providerId, models = [], claudeSettings = {}) {
  if (providerId === 'claude') {
    return {
      project: { model: claudeSettings.reportModel || 'haiku', effort: claudeSettings.reportEffort || 'medium' },
      overview: { model: claudeSettings.finalizerModel || 'sonnet', effort: claudeSettings.finalizerEffort || 'high' }
    };
  }
  const spec = PROVIDERS[providerId] || PROVIDERS.claude;
  const list = models.length ? models : [{ id: 'default', tier: 'balanced' }];
  const fast = list.find((m) => m.tier === 'fast') || list[0];
  const strong = list.find((m) => m.tier === 'strong') || list.find((m) => m.tier === 'balanced') || list[0];
  const pickEffort = (model, want) => {
    const list = model.efforts || spec.efforts;
    return list.includes(want) ? want : model.defaultEffort || list[0] || '';
  };
  return {
    project: { model: fast.id, effort: pickEffort(fast, 'medium') },
    overview: { model: strong.id, effort: pickEffort(strong, 'high') }
  };
}

function codexSnapshot(account, quota, models, now = Date.now()) {
  if (account?.type !== 'chatgpt') return null;
  const bucket = quota?.rateLimitsByLimitId?.codex || quota?.rateLimits;
  const live = {};
  if (!bucket?.limitId || bucket.limitId === 'codex') {
    for (const window of [bucket?.primary, bucket?.secondary]) {
      if (!Number.isFinite(window?.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
        || !Number.isFinite(window.resetsAt) || window.resetsAt * 1000 <= now) continue;
      const name = window.windowDurationMins === 300 ? 'fiveHour' : window.windowDurationMins === 10080 ? 'sevenDay' : '';
      if (name) live[name] = { pct: window.usedPercent, resetsAt: window.resetsAt, seenAt: now };
    }
  }
  const plan = formatSubscriptionTier(account.planType);
  return {
    planLabel: plan ? `ChatGPT ${plan}` : 'ChatGPT',
    live,
    models: Array.isArray(models) ? models.filter((m) => m && !m.hidden).map((m) => ({
      id: m.model || m.id, label: m.displayName, context: m.contextWindow,
      efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((v) => v.reasoningEffort) : undefined,
      defaultEffort: m.defaultReasoningEffort
    })) : []
  };
}

// Query the native CLI app server without starting a thread or a model turn.
// Responses can contain account details; only plan, quota windows and model IDs leave this process.
function readCodexSnapshot({ spawn = childProcess.spawn, timeoutMs = 8000, env = process.env, signal, ...opts } = {}) {
  const bin = resolveProviderBinary(PROVIDERS.codex, { ...opts, env });
  if (!bin || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
      child = spawn(bin.command, [...bin.prefix, 'app-server', '--listen', 'stdio://',
        '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
        '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"', '-c', 'mcp_servers={}'], {
        cwd: WORK_DIR, env: providerEnvironment('codex', env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch { resolve(null); return; }

    const stdout = createInterface({ input: child.stdout });
    child.stderr.resume();
    const responses = new Map();
    let account, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      stdout.close();
      child.stdin.end();
      stopChild(child);
      resolve(codexSnapshot(account, responses.get(2), responses.get(3)?.data));
    };
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener('abort', finish, { once: true });
    child.stdin.on('error', finish);
    child.on('error', finish);
    child.on('close', finish);
    const send = (method, id, params) => child.stdin.write(JSON.stringify({ method, id, params }) + '\n');

    stdout.on('line', (line) => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response?.id === 0) {
        if (!response.result) return finish();
        send('initialized');
        send('account/read', 1, { refreshToken: false });
      } else if (response?.id === 1) {
        account = response.result?.account;
        if (account?.type !== 'chatgpt') return finish();
        send('account/rateLimits/read', 2);
        send('model/list', 3, { limit: 100, includeHidden: false });
      } else if (response?.id === 2 || response?.id === 3) {
        responses.set(response.id, response.result);
        if (responses.size === 2) finish();
      }
    });
    if (signal?.aborted) return finish();
    send('initialize', 0, { clientInfo: { name: 'claude_report', title: 'Claude Report', version: '1' } });
  });
}

function extractUsageFromObject(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input_tokens ?? u.input ?? u.prompt_tokens ?? u.promptTokenCount ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.output ?? u.completion_tokens ?? u.candidatesTokenCount ?? u.candidates ?? 0) || 0;
  const cacheRead = Number(u.cache_read_input_tokens ?? u.cache_read_tokens ?? u.cached_input_tokens ?? u.cached ?? u.cache?.read ?? 0) || 0;
  const cacheCreate = Number(u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? u.cache?.write ?? 0) || 0;
  if (!(input || output || cacheRead || cacheCreate)) return null;
  return { input, output, cacheRead, cacheCreate, totalInput: input + cacheRead + cacheCreate };
}

function addUsage(current, next) {
  if (!next) return current;
  if (!current) return next;
  return Object.fromEntries(Object.keys(current).map((key) => [key, current[key] + next[key]]));
}

function reportUsage(onTokenUsage, usage) {
  if (!onTokenUsage || !usage) return;
  try { onTokenUsage(usage.totalInput, usage); } catch { /* best effort */ }
}

// The CLI's own reason for a failed run (usage limit, quota, sign-in), kept short.
function failureDetail(...texts) {
  const lines = texts.join('\n').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const r = ev?.result && typeof ev.result === 'object' ? ev.result : ev;
    const msg = typeof r?.error === 'string' ? r.error : r?.error?.message || (/error|failed/i.test(r?.type || '') ? r.message : '');
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 300);
  }
  const plain = lines.find((l) => /^(?:error|fatal)\b/i.test(l));
  return plain ? plain.replace(/^(?:error|fatal):?\s*/i, '').slice(0, 300) : '';
}

function parseEnvelopeOutput(out, _schema, onTokenUsage) {
  const trimmed = String(out || '').trim();
  let j;
  try { j = JSON.parse(trimmed); } catch { /* A plain provider response may also be returned. */ }
  if (j && typeof j === 'object') {
    const usage = extractUsageFromObject(j.usage) || Object.values(j.stats?.models || {}).reduce((total, model) => (
      addUsage(total, extractUsageFromObject(model?.tokens))
    ), null);
    reportUsage(onTokenUsage, usage);
    if (j.is_error || j.error || /^(?:error|canceled|interrupted|invalid|waiting|running)$/i.test(j.status)) {
      throw new Error(failureDetail(trimmed) || 'The provider reported an unsuccessful run. Check its CLI and sign-in status.');
    }
    if (j.structured_output !== undefined) return JSON.stringify(j.structured_output);
    for (const key of ['result', 'response', 'text', 'content', 'output']) {
      if (typeof j[key] === 'string' && j[key].trim()) return j[key].trim();
      if (j[key] && typeof j[key] === 'object') return JSON.stringify(j[key]);
    }
  }
  if (trimmed) return trimmed;
  throw new Error('Provider returned an empty response');
}

function parseJsonlEvents(out, provider, onTokenUsage) {
  const lines = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let lastText = '', deltaText = '';
  let lastUsage = null;
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'turn.failed' || ev.type === 'run.failed' || ev.type === 'run.terminal.failed') {
      throw new Error(failureDetail(line) || 'The provider reported an unsuccessful run. Check its CLI and sign-in status.');
    }
    if (provider === 'codex') {
      if (ev.type === 'item.completed' && ev.item && (ev.item.type === 'agent_message' || ev.item.type === 'message')) {
        const text = ev.item.text || ev.item.content;
        if (typeof text === 'string' && text.trim()) lastText = text.trim();
      }
      if (ev.type === 'turn.completed' && ev.usage) {
        const usage = extractUsageFromObject(ev.usage);
        // Codex reports total input including cached tokens.
        if (usage) {
          usage.totalInput = usage.input;
          usage.input = Math.max(0, usage.input - usage.cacheRead);
          lastUsage = usage;
        }
      }
    } else if (provider === 'opencode') {
      if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') lastText += ev.part.text;
      if (ev.type === 'step_finish' && ev.part && ev.part.tokens) lastUsage = addUsage(lastUsage, extractUsageFromObject(ev.part.tokens));
    } else {
      const payload = ev.payload || ev;
      const delta = ev.type === 'run.output.delta' ? payload.text || payload.delta : typeof payload.delta === 'string' ? payload.delta : payload.delta?.text;
      if (typeof delta === 'string') {
        deltaText += delta;
        continue;
      }
      const text = payload.text || payload.result || payload.response || payload.message?.content || payload.item?.text;
      if (typeof text === 'string' && text.trim()) lastText = text.trim();
      else if (Array.isArray(payload.message?.content)) {
        const joined = payload.message.content.filter((c) => typeof c?.text === 'string').map((c) => c.text).join('\n').trim();
        if (joined) lastText = joined;
      }
      const usage = extractUsageFromObject(payload.usage || payload.token_usage)
        || Object.values(payload.usage?.models || payload.models || payload.by_model || {}).reduce((total, model) => (
          addUsage(total, extractUsageFromObject(model?.tokens || model))
        ), null);
      if (usage) lastUsage = usage;
    }
  }
  reportUsage(onTokenUsage, lastUsage);
  if ((lastText || deltaText).trim()) return (lastText || deltaText).trim();
  throw new Error('Provider returned no report text');
}

// agy --output-format stream-json ends with {"event":"result","result":{...}}.
function parseAntigravityStream(out, schema, onTokenUsage) {
  const lines = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev?.event === 'result' && ev.result && typeof ev.result === 'object') {
      return parseEnvelopeOutput(JSON.stringify(ev.result), schema, onTokenUsage);
    }
  }
  throw new Error('Provider returned no report text');
}

function stopChild(child) {
  const kill = () => { try { child.kill(); } catch { /* already gone */ } };
  if (typeof child.exitCode === 'number' || child.signalCode) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', kill);
      killer.on('close', (code) => { if (code !== 0) kill(); });
      killer.unref();
      return;
    } catch { /* fall back to stopping the parent */ }
  }
  kill();
}

function spawnCli({ command, argv, cwd = WORK_DIR, env, stdinText, timeoutMs = 180000, signal, spawn = childProcess.spawn, label = 'cloud' }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let child;
    try {
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      child = spawn(command, argv, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`${label}: could not start: ${e.message}`));
    }
    let out = '', done = false, timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const terminate = (error) => {
      finish(reject, error);
      stopChild(child);
    };
    const onAbort = () => terminate(signal.reason);
    timer = setTimeout(() => terminate(new Error(`${label}: timed out after ${timeoutMs} ms`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (done) return;
      out += d;
      if (out.length > 16 * 1024 * 1024) terminate(new Error(`${label}: response was too large`));
    });
    let errText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (errText.length < 64 * 1024) errText += d; });
    child.on('error', (e) => finish(reject, new Error(`${label}: could not start: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = failureDetail(out.slice(-64 * 1024), errText);
        return finish(reject, new Error(detail ? `${label}: ${detail}` : `${label}: exited with code ${code}. Check its CLI and sign-in status.`));
      }
      finish(resolve, out);
    });
    child.stdin.on('error', () => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

const AUTH_PROBES = {
  claude: ['auth', 'status', '--json'],
  codex: ['login', 'status'],
  muse: ['usage', '--json'],
  antigravity: ['models'],
  cursor: ['status'],
  opencode: ['--version']
};

async function checkRunAuth(spec, bin, { env, signal, homedir, read, timeoutMs, probeSpawn }) {
  const results = new Map();
  const probe = async (args) => {
    try {
      const output = await spawnCli({
        command: bin.command, argv: [...bin.prefix, ...args],
        cwd: WORK_DIR, env: providerEnvironment(spec.id, env), signal,
        spawn: probeSpawn, timeoutMs: Math.min(timeoutMs, 8000), label: spec.label
      });
      results.set(args.join(' '), output);
      return output;
    } catch { signal?.throwIfAborted(); }
    return '';
  };
  if (AUTH_PROBES[spec.id]) {
    const result = await probe(AUTH_PROBES[spec.id]);
    if (spec.id === 'opencode' && openCodeMajor(result) >= 2) await probe(['auth', 'list', '--format', 'json']);
  }
  return detectProvider(spec.id, {
    env, homedir, read, detectedBin: bin, exec: (_command, argv) => results.get(argv.slice(bin.prefix.length).join(' ')) || '',
    skipPlanHistory: true
  });
}

async function runCloudProvider({
  provider = 'claude',
  model,
  effort,
  prompt,
  schema,
  modelEfforts,
  signal,
  timeoutMs = 180000,
  onTokenUsage,
  spawn = childProcess.spawn,
  resolve = resolveBinary,
  env = process.env,
  homedir = os.homedir,
  read,
  probeSpawn = childProcess.spawn
}) {
  signal?.throwIfAborted();
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Unknown cloud provider: ${provider}`);
  const bin = resolveProviderBinary(spec, { resolve, env, homedir });
  if (!bin) throw new Error(`${spec.label}: CLI "${spec.bin}" not found`);
  const detected = await checkRunAuth(spec, bin, { env, signal, homedir, read, timeoutMs, probeSpawn });
  if (!detected.connected) throw new Error(`${spec.label}: ${detected.reason}`);

  const selectedModel = model && model !== 'default' ? model : '';
  if (selectedModel && !validModelId(selectedModel)) throw new Error(`${spec.label}: Invalid report model`);
  if (provider === 'claude' && !MODELS.includes(selectedModel)) throw new Error(`${spec.label}: Invalid report model`);
  if (provider === 'opencode' && (!selectedModel.includes('/') || !detected.oauthProviders.includes(selectedModel.split('/')[0]))) {
    throw new Error('OpenCode requires a model from a signed-in OAuth provider');
  }
  const allowedEfforts = modelEfforts || spec.efforts;
  const selectedEffort = allowedEfforts.includes(effort) && spec.efforts.includes(effort) ? effort : '';

  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  const cwd = fs.mkdtempSync(path.join(WORK_DIR, 'run-'));
  const temps = [];
  const tempFile = (name, content) => {
    const file = path.join(cwd, name);
    temps.push(file);
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    return file;
  };
  const childEnv = providerEnvironment(provider, env);
  const run = (args, stdinText = prompt) => spawnCli({
    command: bin.command, argv: [...bin.prefix, ...args], cwd, env: childEnv,
    stdinText, timeoutMs, signal, spawn, label: spec.label
  });

  try {
    if (provider === 'claude') {
      const args = ['-p', '--model', selectedModel, '--output-format', 'json', '--no-session-persistence',
        '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands'];
      if (selectedEffort) args.push('--effort', selectedEffort);
      if (schema) args.push('--json-schema', JSON.stringify(schema));
      return parseEnvelopeOutput(await run(args), Boolean(schema), onTokenUsage);
    }

    if (provider === 'codex') {
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
        '--sandbox', 'read-only', '-C', cwd, '--json', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
        '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'allow_login_shell=false'];
      const codexDir = env.CODEX_HOME || path.join(homedir(), '.codex');
      const { authStore } = parseCodexConfig(readTextSafe(path.join(codexDir, 'config.toml'), read));
      if (authStore) args.push('-c', `cli_auth_credentials_store=${JSON.stringify(authStore)}`);
      if (selectedModel) args.push('-m', selectedModel);
      if (selectedEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(selectedEffort)}`);
      if (schema) args.push('--output-schema', tempFile('schema.json', JSON.stringify(schema)));
      args.push('-');
      return parseJsonlEvents(await run(args), provider, onTokenUsage);
    }

    if (provider === 'muse') {
      const promptFile = tempFile('prompt.txt', prompt);
      const args = ['exec', '--provider', 'meta', '--json', '--prompt-file', promptFile, '--no-session-log', '--max-model-steps', '1',
        '--disable-write', '--disable-shell', '--disable-web-tools', '--disable-reminders', '--disable-request-user-input', '--no-foreign-personal-context'];
      if (selectedModel) args.push('--model', selectedModel);
      if (selectedEffort) args.push('--reasoning-effort', selectedEffort);
      if (schema) args.push('--output-schema', tempFile('schema.json', JSON.stringify(schema)));
      return parseJsonlEvents(await run(args, null), provider, onTokenUsage);
    }

    if (provider === 'antigravity') {
      const agSettings = tempFile('settings.json', JSON.stringify({
        agentMode: '', toolPermission: 'strict', allowNonWorkspaceAccess: false,
        permissions: { deny: ['command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)', 'write_file(*)'] }
      }));
      // agy takes -p's value as the prompt, so the prompt goes through stdin as one stream-json user message.
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--settings', agSettings];
      if (selectedModel) args.push('--model', selectedModel);
      if (selectedEffort && !antigravityModelHasFixedEffort(selectedModel)) args.push('--effort', selectedEffort);
      if (schema) args.push('--json-schema', tempFile('schema.json', JSON.stringify(schema)));
      const message = `${JSON.stringify({ event: 'user', message: { content: prompt } })}
`;
      return parseAntigravityStream(await run(args, message), Boolean(schema), onTokenUsage);
    }

    if (provider === 'opencode') {
      const isV2 = detected.openCodeMajor >= 2;
      const choice = isV2 && selectedEffort ? `${selectedModel}#${selectedEffort}` : selectedModel;
      const args = ['run', '--format', 'json', '--model', choice];
      if (isV2) args.push('--standalone', '--archived');
      else if (selectedEffort) args.push('--variant', selectedEffort);
      return parseJsonlEvents(await run(args), provider, onTokenUsage);
    }

    if (provider === 'cursor') {
      tempFile('prompt.txt', prompt);
      const args = ['-p', '--mode', 'ask', '--trust', '--output-format', 'json'];
      if (selectedModel) args.push('--model', selectedModel);
      args.push('Read @prompt.txt, follow its report instructions, and reply with the exact requested output.');
      return parseEnvelopeOutput(await run(args, null), Boolean(schema), onTokenUsage);
    }

    if (provider === 'gemini') {
      const args = ['--output-format', 'json', '--approval-mode', 'plan', '--extensions', 'none'];
      if (selectedModel) args.push('--model', selectedModel);
      return parseEnvelopeOutput(await run(args), Boolean(schema), onTokenUsage);
    }
  } finally {
    for (const f of temps) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    try { fs.rmdirSync(cwd); } catch { /* a provider may leave its own files */ }
  }
}

module.exports = {
  PROVIDER_IDS,
  PROVIDERS,
  resolveBinary,
  providerEnvironment,
  detectProvider,
  detectCloudProviders,
  discoverProviderModels,
  defaultCloudModels,
  readCodexSnapshot,
  runCloudProvider,
  formatSubscriptionTier,
  parseJsonlEvents,
  parseEnvelopeOutput
};
