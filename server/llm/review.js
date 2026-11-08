/**
 * "Needs a look": when the extractor can't choose between two categories, the
 * spend is saved with its best guess and flagged, so Home can ask one quick
 * question instead of silently filing it wrong.
 *
 * Kept apart from extract.js so the rule can be tested without a model client.
 */

/**
 * Review fields for one extraction. `chosen` is the canonical category already
 * picked. Returns {} when the model was sure, otherwise
 * { needsReview: true, categoryOptions: [chosen, alternative?] }.
 */
export function reviewFields({ categorySure, otherCategory } = {}, categories = [], chosen = 'General') {
  if (categorySure !== false) return {};

  const other = categories.find((c) => c.toLowerCase() === String(otherCategory || '').trim().toLowerCase());
  const options = [chosen, other].filter(Boolean).filter((c, i, all) => all.indexOf(c) === i);
  return { needsReview: true, categoryOptions: options };
}

/** A learned rule is the user's own answer, so it never needs a second look. */
export function withoutReview(expense) {
  const copy = { ...expense };
  delete copy.needsReview;
  delete copy.categoryOptions;
  return copy;
}
