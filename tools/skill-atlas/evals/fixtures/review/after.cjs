exports.list = function list(records, tenant, limit = 20) {
  records.sort((a, b) => b.updated - a.updated);
  return records.filter(r => r.tenant === tenant || !r.deleted).slice(0, limit);
};
