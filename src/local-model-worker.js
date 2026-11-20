'use strict';

const { parentPort, workerData: { engine, model, details, fit } } = require('node:worker_threads');
const lm = require('./local-models');
const { modelInfo } = require('./local-report');

async function scan() {
  const [engines, gpu] = await Promise.all([lm.detectEngines(), details || fit ? lm.gpuInfo() : null]);
  const running = engines.find((item) => item.engine === engine && item.running);
  if (!running) return { gpu, engines, models: [] };
  const info = await modelInfo({ engine, model });
  const measured = !details && !fit && engine === 'lmstudio' && info.length ? []
    : await lm.listModels({ engine, baseUrl: running.baseUrl, gpu });
  const list = measured.length ? [...measured, ...info.filter((entry) =>
    !measured.some((item) => entry.id === item.id || entry.instanceId === item.id))] : info;
  const models = list.map((item) => {
    const merged = { ...item, ...info.find((entry) => entry.id === item.id || entry.instanceId === item.id) };
    const context = merged.loadedContext || merged.reportContext;
    return {
      ...merged,
      maxContextLabel: merged.maxContext ? lm.formatTokens(merged.maxContext) : '',
      maxOnGpuLabel: merged.maxOnGpu === 0 ? 'too big' : merged.maxOnGpu ? lm.formatTokens(merged.maxOnGpu) : '',
      reportContextLabel: context === 0 ? 'low VRAM' : context ? lm.formatTokens(context) : ''
    };
  });
  if (engine === 'ollama' && !model) {
    const loaded = models.find((item) => item.state === 'loaded');
    if (loaded) Object.assign(loaded, (await modelInfo({ engine, model: loaded.id }))[0]);
  }
  return { engines, gpu, models };
}

scan().then((data) => parentPort.postMessage(data)).catch((error) => {
  parentPort.postMessage({ error: error.message });
});
