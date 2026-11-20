'use strict';

// Hard limits on model requests, so a bug or a stray script cannot fan one report out across
// every project and every effort. A Deep run plans its requests first, then must stay inside that plan.

// Wraps a model runner. A request is refused before it starts when its kind is not planned,
// when it asks for a different review depth, or when the planned count is used up.
function requestBudget({ depth, limits }) {
  const used = {};
  const guard = (run) => async (request) => {
    const kind = request.kind;
    if (!Object.hasOwn(limits, kind)) throw new Error('Request budget: ' + kind + ' requests are not planned for this run.');
    if (depth && kind === 'deep-review' && request.depth !== depth) {
      throw new Error('Request budget: this run reviews at ' + depth + ' depth only.');
    }
    if ((used[kind] || 0) >= limits[kind]) {
      throw new Error('Request budget: ' + limits[kind] + ' ' + kind + ' request' + (limits[kind] === 1 ? '' : 's') + ' planned, none left.');
    }
    used[kind] = (used[kind] || 0) + 1;
    return run(request);
  };
  guard.used = () => ({ ...used });
  return guard;
}

// Runs fn over items with at most `limit` in flight. Results keep the input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// Requests a Deep run may make: its non-cached review batches, one extra split per project, one synthesis.
function plannedRequests(plan) {
  const live = plan.filter((item) => !item.reused);
  const reviews = live.reduce((total, item) => total + item.chunks, 0);
  return { review: reviews, limit: reviews + live.length };
}

module.exports = { requestBudget, mapLimit, plannedRequests, DEEP_CONCURRENCY: 3 };
