import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewFields, withoutReview } from '../server/llm/review.js';

const CATEGORIES = ['Food', 'Groceries', 'Shopping', 'Electronics', 'General'];

test('a sure extraction is saved without a question', () => {
  assert.deepEqual(reviewFields({ categorySure: true, otherCategory: null }, CATEGORIES, 'Food'), {});
  // Older model output without the field counts as sure, never as a question.
  assert.deepEqual(reviewFields({}, CATEGORIES, 'Food'), {});
});

test('an unsure extraction offers the best guess and the runner-up', () => {
  assert.deepEqual(
    reviewFields({ categorySure: false, otherCategory: 'electronics' }, CATEGORIES, 'Shopping'),
    { needsReview: true, categoryOptions: ['Shopping', 'Electronics'] },
  );
});

test('an unknown or repeated runner-up is dropped, but the question stays', () => {
  assert.deepEqual(
    reviewFields({ categorySure: false, otherCategory: 'Gadgets' }, CATEGORIES, 'Shopping'),
    { needsReview: true, categoryOptions: ['Shopping'] },
  );
  assert.deepEqual(
    reviewFields({ categorySure: false, otherCategory: 'Shopping' }, CATEGORIES, 'Shopping'),
    { needsReview: true, categoryOptions: ['Shopping'] },
  );
});

test('a learned rule clears the question', () => {
  const ruled = withoutReview({ merchant: 'Zepto', category: 'Groceries', needsReview: true, categoryOptions: ['Food'] });
  assert.equal('needsReview' in ruled, false);
  assert.equal('categoryOptions' in ruled, false);
  assert.equal(ruled.category, 'Groceries');
});
