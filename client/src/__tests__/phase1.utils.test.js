import {
  formatRoundBlockStartTime,
  mapCourtLabel,
  normalizeTournamentSchedule,
} from '../utils/phase1.js';

describe('mapCourtLabel', () => {
  it('maps known facility court codes to display names', () => {
    expect(mapCourtLabel('VC-1')).toBe('Volleyball Center 1');
    expect(mapCourtLabel('VC-2')).toBe('Volleyball Center 2');
    expect(mapCourtLabel('SRC-1')).toBe('SRC Court 1');
  });

  it('returns original value for unknown codes', () => {
    expect(mapCourtLabel('AUX-1')).toBe('AUX-1');
  });
});

describe('formatRoundBlockStartTime', () => {
  it('formats times from round blocks using schedule settings', () => {
    const tournament = {
      timezone: 'America/New_York',
      settings: {
        schedule: {
          dayStartTime: '09:00',
          matchDurationMinutes: 60,
        },
      },
    };

    expect(formatRoundBlockStartTime(1, tournament)).toBe('9:00 AM');
    expect(formatRoundBlockStartTime(2, tournament)).toBe('10:00 AM');
    expect(formatRoundBlockStartTime(3, tournament)).toBe('11:00 AM');
  });

  it('falls back to defaults when schedule is missing or invalid', () => {
    const tournamentWithMissingSchedule = {
      timezone: 'America/New_York',
      settings: {},
    };
    const tournamentWithInvalidSchedule = {
      timezone: 'America/New_York',
      settings: {
        schedule: {
          dayStartTime: 'bad-value',
          matchDurationMinutes: -30,
        },
      },
    };

    expect(normalizeTournamentSchedule(tournamentWithMissingSchedule)).toEqual({
      dayStartTime: '09:00',
      matchDurationMinutes: 60,
      lunchStartTime: null,
      lunchDurationMinutes: 45,
    });
    expect(formatRoundBlockStartTime(1, tournamentWithMissingSchedule)).toBe('9:00 AM');
    expect(formatRoundBlockStartTime(2, tournamentWithInvalidSchedule)).toBe('10:00 AM');
  });
});
