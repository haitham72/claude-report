'use strict';

// Background worker: probes installed signed-in CLI hooks, lists their models,
// and computes empirical subscription % calibration without blocking the extension host.
const { parentPort, workerData } = require('worker_threads');
const { detectCloudProviders, discoverProviderModels, readCodexSnapshot } = require('./cloud-providers');
const { calibrateCodex, calibrateClaude, readMuseQuota, resolveCalibration } = require('./quota-calibration');

async function runCloudScan({ homeDir, claudeLive = null } = {}) {
  const modelCatalogs = new Map();
  const providers = detectCloudProviders({ modelCatalogs, skipPlanHistory: true });
  const codex = providers.find((p) => p.id === 'codex');
  const codexSnapshot = codex?.connected ? await readCodexSnapshot() : null;
  if (codexSnapshot) {
    codex.planLabel = codexSnapshot.planLabel;
    modelCatalogs.set('codex', codexSnapshot.models);
  }
  const modelsByProvider = {};
  for (const p of providers) {
    if (!p.connected) continue;
    modelsByProvider[p.id] = discoverProviderModels(p.id, { detected: p, modelCatalogs });
    if (!modelsByProvider[p.id].length) {
      p.connected = false;
      p.status = 'unavailable';
      p.reason = 'No eligible models were returned for the signed-in account.';
    }
  }

  const codexData = codex?.connected ? calibrateCodex() : null;
  if (codex?.planLabel === 'ChatGPT' && codexData?.planLabel) codex.planLabel = codexData.planLabel;
  const claudeEmp = providers.find((p) => p.id === 'claude' && p.connected) ? calibrateClaude({ historyDir: homeDir }) : null;
  const museQuota = providers.find((p) => p.id === 'muse' && p.connected) ? readMuseQuota() : null;

  const liveQuotas = {};
  if (claudeLive && (claudeLive.fiveHour || claudeLive.sevenDay)) liveQuotas.claude = claudeLive;
  const codexLive = codexSnapshot?.live || codexData?.live;
  if (codexLive?.fiveHour || codexLive?.sevenDay) liveQuotas.codex = codexLive;
  if (museQuota?.available) liveQuotas.muse = museQuota;

  const calibrations = {};
  for (const p of providers) {
    const empirical = p.id === 'claude' ? claudeEmp : p.id === 'codex' ? codexData : null;
    const planLabel = (p.id === 'muse' && museQuota?.planLabel) || p.planLabel;
    calibrations[p.id] = resolveCalibration({ provider: p.id, planLabel, empirical });
    if (p.id === 'muse' && museQuota?.planLabel && !p.planLabel) p.planLabel = museQuota.planLabel;
  }

  return { providers, modelsByProvider, calibrations, liveQuotas };
}

if (parentPort) {
  runCloudScan(workerData || {}).then((state) => parentPort.postMessage(state));
}

module.exports = { runCloudScan };
