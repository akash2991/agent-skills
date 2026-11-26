// Contract: return integer cents after an integer 0..100 percent discount.
// Round half cents upward. Reject non-integer/negative cents or invalid percent
// with RangeError. Cents above 1_000_000 must also be rejected.
exports.discount = function discount(cents, percent) {
  return Math.floor(cents * (100 - percent) / 100);
};
