'use strict';

// The status bar's numbers come from several places. The model and context are read from
// transcripts, which every IDE writes. 5h and 7d plan usage come from the OAuth usage poll /
// shared cache and from the status-line hook (newest wins in readLive). The hook reading is
// preferred for model/context while fresh. Account windows stay available even when the
// session snapshot has gone stale.
function mergeLive({ hook, transcript }) {
  const fresh = hook && !hook.stale ? hook : null;
  const base = fresh || transcript || hook || null;
  if (!base) return null;
  return {
    model: base.model || null,
    ctxPct: base.ctxPct != null ? base.ctxPct : null,
    updatedAt: base.updatedAt,
    stale: !!base.stale,
    source: fresh ? 'hook' : transcript ? 'transcript' : 'hook',
    fiveHour: (hook && hook.fiveHour) || null,
    sevenDay: (hook && hook.sevenDay) || null
  };
}

module.exports = { mergeLive };
