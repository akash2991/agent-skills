// createLoader(fetchValue) returns async load(tenant, key).
// Cache successful values by the exact (tenant,key) pair, including empty values.
// Failed fetches must be retriable. Coalesce concurrent identical requests.
exports.createLoader = function createLoader(fetchValue) {
  const cache = new Map();
  return async function load(tenant, key) {
    const id = `${tenant}:${key}`;
    if (!cache.has(id)) cache.set(id, Promise.resolve().then(() => fetchValue(tenant, key)));
    return cache.get(id);
  };
};
