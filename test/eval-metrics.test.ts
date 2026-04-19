import { describe, test, expect } from 'bun:test';
import { precisionAtK, recallAtK, mrr, ndcgAtK } from '../src/core/search/eval.ts';

describe('eval metrics', () => {
  const relevant = new Set(['a', 'b', 'c']);

  test('precisionAtK: all relevant', () => {
    expect(precisionAtK(['a', 'b', 'c'], relevant, 3)).toBeCloseTo(1.0);
  });

  test('precisionAtK: half relevant', () => {
    expect(precisionAtK(['a', 'x', 'c'], relevant, 3)).toBeCloseTo(2 / 3);
  });

  test('precisionAtK: none relevant', () => {
    expect(precisionAtK(['x', 'y', 'z'], relevant, 3)).toBe(0);
  });

  test('precisionAtK: empty hits', () => {
    expect(precisionAtK([], relevant, 3)).toBe(0);
  });

  test('precisionAtK: empty relevant', () => {
    expect(precisionAtK(['a', 'b'], new Set(), 3)).toBe(0);
  });

  test('recallAtK: all found', () => {
    expect(recallAtK(['a', 'b', 'c', 'x'], relevant, 4)).toBeCloseTo(1.0);
  });

  test('recallAtK: partial', () => {
    expect(recallAtK(['a', 'x'], relevant, 3)).toBeCloseTo(1 / 3);
  });

  test('recallAtK: none found', () => {
    expect(recallAtK(['x', 'y', 'z'], relevant, 3)).toBe(0);
  });

  test('mrr: first hit relevant', () => {
    expect(mrr(['a', 'x', 'y'], relevant)).toBeCloseTo(1.0);
  });

  test('mrr: second hit relevant', () => {
    expect(mrr(['x', 'b', 'y'], relevant)).toBeCloseTo(0.5);
  });

  test('mrr: no relevant hit', () => {
    expect(mrr(['x', 'y', 'z'], relevant)).toBe(0);
  });

  test('ndcgAtK: perfect ranking', () => {
    const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
    expect(ndcgAtK(['a', 'b', 'c'], grades, 3)).toBeCloseTo(1.0);
  });

  test('ndcgAtK: reversed ranking', () => {
    const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
    const score = ndcgAtK(['c', 'b', 'a'], grades, 3);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1.0);
  });

  test('ndcgAtK: no relevant hits', () => {
    const grades = new Map([['a', 1]]);
    expect(ndcgAtK(['x', 'y', 'z'], grades, 3)).toBe(0);
  });

  test('ndcgAtK: binary relevance', () => {
    const grades = new Map([['a', 1], ['b', 1], ['c', 1]]);
    expect(ndcgAtK(['a', 'x', 'b'], grades, 3)).toBeGreaterThan(0);
    expect(ndcgAtK(['a', 'x', 'b'], grades, 3)).toBeLessThan(1.0);
  });
});
