'use strict';

// The status bar's numbers come from two places. The model and context are read from
// transcripts, which every IDE writes. The status line hook, where Claude Code runs it,
// is preferred while its reading is fresh (it knows the real window size) and is the
// only source of 5h and 7d plan usage. Those two windows belong to the account, so they are
// kept from the hook even when its model and context have gone stale.
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
