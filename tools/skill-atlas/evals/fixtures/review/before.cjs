// Existing API: list visible records without modifying the input array.
exports.list = function list(records, tenant) {
  return records.filter(r => r.tenant === tenant && !r.deleted);
};
