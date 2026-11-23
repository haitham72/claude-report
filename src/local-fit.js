'use strict';

// Which local model to run, and whether to warn before loading it. Pure: the extension shows the prompt.
// reportContext is the context that fits in GPU memory free right now at a 90% budget (null when
// unknown, 0 when the weights alone do not fit). Below GOOD_CONTEXT a report still runs but cards
// get thin, so the user is asked first.
const GOOD_CONTEXT = 16384;
const MIN_CONTEXT = 8192;

const fitsAt = (m, ctx) => m.state === 'loaded' || (Number.isFinite(m.reportContext) && m.reportContext >= ctx);
const bySizeDesc = (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0);

// Models that fit now, best first: comfortable fits before tight ones, larger before smaller.
function fittingModels(models) {
  const list = (models || []).filter((m) => fitsAt(m, MIN_CONTEXT));
  return [...list.filter((m) => fitsAt(m, GOOD_CONTEXT)).sort(bySizeDesc), ...list.filter((m) => !fitsAt(m, GOOD_CONTEXT)).sort(bySizeDesc)];
}

// The picked model; else the loaded one; else the best that fits; else the smallest known.
function pickModel(models, wanted) {
  const all = models || [];
  if (wanted) return all.find((m) => m.id === wanted || m.instanceId === wanted) || null;
  return all.find((m) => m.state === 'loaded') || fittingModels(all)[0]
    || [...all].sort((a, b) => (a.sizeBytes || Infinity) - (b.sizeBytes || Infinity))[0] || null;
}

const gb = (bytes) => (bytes / 1e9).toFixed(1) + ' GB';
const k = (tokens) => Math.round(tokens / 1024) + 'k';

// null when there is nothing to decide; otherwise the message and the best alternative to offer.
function fitAdvice(model, gpu, models) {
  if (!model || model.state === 'loaded' || !gpu || !Number.isFinite(model.reportContext)) return null;
  const alt = fittingModels(models).find((m) => m.id !== model.id) || null;
  const free = `${(gpu.freeMiB / 1024).toFixed(1)} GB of ${Math.round(gpu.totalMiB / 1024)} GB GPU memory is free.`;
  if (model.reportContext === 0) {
    return { kind: 'spill', alt, message: `${free} ${model.id} needs about ${model.sizeBytes ? gb(model.sizeBytes) : 'more than that'}, so part of it will run from system memory, which is much slower. Close other GPU apps and recheck, load it anyway, or use a model that fits.` };
  }
  if (model.reportContext < GOOD_CONTEXT) {
    return { kind: 'tight', alt, message: `${free} ${model.id} fits, but its context will be limited to ${k(model.reportContext)} tokens, so long projects are trimmed. Free GPU memory and recheck for more.` };
  }
  return null;
}

module.exports = { GOOD_CONTEXT, MIN_CONTEXT, fittingModels, pickModel, fitAdvice };
