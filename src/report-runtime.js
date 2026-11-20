'use strict';

const { performance } = require('node:perf_hooks');
const { scrubDeep } = require('./scan');

function reportRuntime(panel, signal, log, operation) {
  let started;
  const events = [];
  const elapsed = () => started === undefined ? 0 : Math.round(performance.now() - started);
  const event = (message, durationMs) => {
    if (started === undefined) return;
    const text = scrubDeep(message);
    events.push({ atMs: elapsed(), text, ...(durationMs === undefined ? {} : { durationMs }) });
    log(`report [${operation}] +${formatDuration(elapsed())} ${text}${durationMs === undefined ? '' : ' (' + formatDuration(durationMs) + ')'}`);
  };
  const stage = (name, text, details) => {
    event(text);
    panel.post({ type: 'stage', stage: name, text, durationMs: started === undefined ? undefined : elapsed(), ...details });
  };
  return {
    signal,
    start() {
      signal.throwIfAborted();
      started = performance.now();
      panel.post({ type: 'runStart' });
      event('Started');
    },
    get started() { return started !== undefined; },
    stage,
    event,
    progress(update) {
      const { project, status, detail, error } = update;
      if (!project) return;
      event([project, status, detail, error].filter(Boolean).join(' · '));
      panel.post({ type: 'progress', project, status, detail, error });
    },
    model(run) {
      return async (request) => {
        const start = performance.now();
        const label = request.label || request.kind;
        try {
          const result = await run({ ...request, signal });
          event(label + ' model request completed', Math.round(performance.now() - start));
          return result;
        } catch (error) {
          event(label + (signal.aborted ? ' model request cancelled' : ' model request failed'),
            Math.round(performance.now() - start));
          throw error;
        }
      };
    },
    metadata() {
      return { durationMs: elapsed(), events: [...events] };
    }
  };
}

function formatDuration(ms) {
  if (ms < 1000) return ms + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  const seconds = Math.round(ms / 1000);
  return Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' s';
}

module.exports = { reportRuntime, formatDuration };
