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

// null when there is nothing to decide; otherwise the message and the best alternative to offer.
// Asks only when the model file is larger than the GPU memory free right now. A tight context
// or a cautious budget estimate is not worth interrupting for: the load just goes ahead.
function fitAdvice(model, gpu, models) {
  if (!model || model.state === 'loaded' || !gpu || !(model.sizeBytes > 0)) return null;
  if (model.sizeBytes <= gpu.freeMiB * 1024 * 1024) return null;
  const alt = fittingModels(models).find((m) => m.id !== model.id) || null;
  return { kind: 'spill', alt, message: `${model.id} is larger than your free GPU memory, so it may run slower.` };
}

module.exports = { GOOD_CONTEXT, MIN_CONTEXT, fittingModels, pickModel, fitAdvice };
