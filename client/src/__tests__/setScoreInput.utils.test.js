import {
  hasDecisiveWinner,
  normalizeSetScoresInput,
  parseSetScoreLine,
} from '../utils/setScoreInput.js';

describe('setScoreInput utils', () => {
  it('parses comma-separated set scores', () => {
    expect(parseSetScoreLine('25-18,22-25,15-11')).toEqual([
      { a: 25, b: 18 },
      { a: 22, b: 25 },
      { a: 15, b: 11 },
    ]);
  });

  it('parses whitespace-separated set scores', () => {
    expect(parseSetScoreLine('25-18 22-25 15-11')).toEqual([
      { a: 25, b: 18 },
      { a: 22, b: 25 },
      { a: 15, b: 11 },
    ]);
  });

  it('rejects malformed set score input', () => {
    expect(() => normalizeSetScoresInput('25:18,22-25')).toThrow(/format/i);
    expect(() => normalizeSetScoresInput([{ a: -1, b: 20 }, { a: 25, b: 23 }])).toThrow(
      />= 0/i
    );
    expect(() => normalizeSetScoresInput('25-18')).toThrow(/2 or 3 sets/i);
  });

  it('detects whether scores imply a decisive winner', () => {
    expect(
      hasDecisiveWinner([
        { a: 25, b: 20 },
        { a: 22, b: 25 },
        { a: 15, b: 11 },
      ])
    ).toBe(true);

    expect(
      hasDecisiveWinner([
        { a: 25, b: 20 },
        { a: 20, b: 25 },
      ])
    ).toBe(false);
  });
});
