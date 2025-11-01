import { shouldEnableDeleteSet } from '../components/controlPanel.utils.js';

describe('shouldEnableDeleteSet', () => {
  it('returns true only when viewing the last completed set in history mode', () => {
    expect(shouldEnableDeleteSet('history', 3, 2)).toBe(true);
  });

  it('returns false when there are no completed sets', () => {
    expect(shouldEnableDeleteSet('history', 0, 0)).toBe(false);
  });

  it('returns false when viewing an earlier set', () => {
    expect(shouldEnableDeleteSet('history', 3, 1)).toBe(false);
  });

  it('returns false when in current mode even if index matches last', () => {
    expect(shouldEnableDeleteSet('current', 3, 2)).toBe(false);
  });
});
