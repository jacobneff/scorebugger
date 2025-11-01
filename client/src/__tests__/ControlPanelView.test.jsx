import { shouldEnableDeleteSet } from '../components/controlPanel.utils.js';

describe('shouldEnableDeleteSet', () => {
  it('returns false when there are no completed sets', () => {
    expect(
      shouldEnableDeleteSet({
        mode: 'current',
        totalCompletedSets: 0,
        displayedHistoryIndex: 0,
        hasDraftSet: false,
      })
    ).toBe(false);
  });

  it('allows delete when editing the last set in current mode with completed sets', () => {
    expect(
      shouldEnableDeleteSet({
        mode: 'current',
        totalCompletedSets: 2,
        displayedHistoryIndex: 0,
        hasDraftSet: true,
      })
    ).toBe(true);
  });

  it('allows delete when editing the last completed set with no draft', () => {
    expect(
      shouldEnableDeleteSet({
        mode: 'current',
        totalCompletedSets: 2,
        displayedHistoryIndex: 0,
        hasDraftSet: false,
      })
    ).toBe(true);
  });

  it('allows delete when viewing the final completed set with no in-progress set', () => {
    expect(
      shouldEnableDeleteSet({
        mode: 'history',
        totalCompletedSets: 3,
        displayedHistoryIndex: 2,
        hasDraftSet: false,
      })
    ).toBe(true);
  });

  it('prevents delete when looking at an earlier completed set', () => {
    expect(
      shouldEnableDeleteSet({
        mode: 'history',
        totalCompletedSets: 3,
        displayedHistoryIndex: 1,
        hasDraftSet: false,
      })
    ).toBe(false);
  });

  it('prevents delete when a newer in-progress set exists', () => {
    expect(
      shouldEnableDeleteSet({
        mode: 'history',
        totalCompletedSets: 2,
        displayedHistoryIndex: 1,
        hasDraftSet: true,
      })
    ).toBe(false);
  });
});
