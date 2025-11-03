const { createTokenPair } = require('../utils/tokens');

describe('createTokenPair', () => {
  const fixedNow = 1_700_000_000_000;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
  });

  test('falls back to minimum TTL when not provided', () => {
    const { token, tokenHash, expiresAt } = createTokenPair();

    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    expect(typeof tokenHash).toBe('string');
    expect(tokenHash).toHaveLength(64);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBe(fixedNow + 60_000);
  });

  test('ensures minimum TTL when provided value is too small', () => {
    const { expiresAt } = createTokenPair(5_000);

    expect(expiresAt.getTime()).toBe(fixedNow + 60_000);
  });

  test('uses provided TTL when valid', () => {
    const { expiresAt } = createTokenPair(120_000);

    expect(expiresAt.getTime()).toBe(fixedNow + 120_000);
  });
});
