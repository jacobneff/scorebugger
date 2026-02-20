import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TournamentFormatAdmin from '../pages/TournamentFormatAdmin.jsx';

let mockAuthState = {
  token: 'test-token',
  user: { id: 'user-1', email: 'owner@example.com' },
  initializing: false,
};

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'tour-1' }),
  useNavigate: () => vi.fn(),
}));

const classic14FormatDef = {
  id: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
  name: '14 Teams: Mixed Pools + Crossover, Gold 8 + Silver 6',
  description: '14 team format',
  supportedTeamCounts: [14],
  minCourts: 3,
  stages: [
    {
      type: 'poolPlay',
      key: 'poolPlay1',
      displayName: 'Pool Play',
      pools: [
        { name: 'A', size: 4 },
        { name: 'B', size: 4 },
        { name: 'C', size: 3 },
        { name: 'D', size: 3 },
      ],
    },
    {
      type: 'crossover',
      key: 'crossover',
      displayName: 'Crossover',
      fromPools: ['C', 'D'],
      pairings: 'rankToRank',
    },
    {
      type: 'playoffs',
      key: 'playoffs',
      displayName: 'Playoffs',
      brackets: [
        {
          name: 'Gold',
          size: 8,
          seedsFromOverall: [1, 2, 3, 4, 5, 6, 7, 8],
          type: 'singleElim',
        },
        {
          name: 'Silver',
          size: 6,
          seedsFromOverall: [9, 10, 11, 12, 13, 14],
          type: 'singleElimWithByes',
        },
      ],
    },
  ],
};

const odu15FormatDef = {
  id: 'odu_15_5courts_v1',
  name: 'ODU 15-Team Classic',
  description: 'Legacy format',
  supportedTeamCounts: [15],
  minCourts: 3,
  stages: [
    {
      type: 'poolPlay',
      key: 'poolPlay1',
      displayName: 'Pool Play 1',
      pools: [
        { name: 'A', size: 3 },
        { name: 'B', size: 3 },
        { name: 'C', size: 3 },
        { name: 'D', size: 3 },
        { name: 'E', size: 3 },
      ],
    },
    {
      type: 'poolPlay',
      key: 'poolPlay2',
      displayName: 'Pool Play 2',
      pools: [
        { name: 'F', size: 3 },
        { name: 'G', size: 3 },
        { name: 'H', size: 3 },
        { name: 'I', size: 3 },
        { name: 'J', size: 3 },
      ],
    },
    {
      type: 'playoffs',
      key: 'playoffs',
      displayName: 'Playoffs',
      brackets: [
        { name: 'Gold', size: 5, seedsFromOverall: [1, 2, 3, 4, 5], type: 'oduFiveTeamOps' },
      ],
    },
  ],
};

describe('TournamentFormatAdmin', () => {
  beforeEach(() => {
    mockAuthState = {
      token: 'test-token',
      user: { id: 'user-1', email: 'owner@example.com' },
      initializing: false,
    };
    globalThis.fetch = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders simplified format tab and auto-applies with force after conflict', async () => {
    const applyUrls = [];
    const teams = Array.from({ length: 14 }, (_, index) => ({
      _id: `team-${index + 1}`,
      name: `Team ${index + 1}`,
      shortName: `T${index + 1}`,
      orderIndex: index + 1,
    }));
    let appliedFormatId = classic14FormatDef.id;
    const activeCourts = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];

    globalThis.fetch.mockImplementation(async (url, options = {}) => {
      const requestUrl = String(url);
      const method = options.method || 'GET';

      if (requestUrl.endsWith('/api/tournaments/tour-1') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            _id: 'tour-1',
            name: 'City Open',
            publicCode: 'ABC123',
            isOwner: true,
            facilities: {
              SRC: ['SRC-1', 'SRC-2', 'SRC-3'],
              VC: ['VC-1', 'VC-2'],
            },
            settings: {
              format: {
                formatId: appliedFormatId,
                activeCourts,
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams') && method === 'GET') {
        return { ok: true, json: async () => teams };
      }

      if (
        requestUrl.includes('/api/tournament-formats/suggest?teamCount=14&courtCount=5') &&
        method === 'GET'
      ) {
        return {
          ok: true,
          json: async () => [
            {
              id: classic14FormatDef.id,
              name: classic14FormatDef.name,
              description: classic14FormatDef.description,
              supportedTeamCounts: classic14FormatDef.supportedTeamCounts,
              minCourts: classic14FormatDef.minCourts,
            },
            {
              id: odu15FormatDef.id,
              name: odu15FormatDef.name,
              description: odu15FormatDef.description,
              supportedTeamCounts: odu15FormatDef.supportedTeamCounts,
              minCourts: odu15FormatDef.minCourts,
            },
          ],
        };
      }

      if (
        requestUrl.endsWith(`/api/tournament-formats/${classic14FormatDef.id}`) &&
        method === 'GET'
      ) {
        return { ok: true, json: async () => classic14FormatDef };
      }

      if (requestUrl.endsWith(`/api/tournament-formats/${odu15FormatDef.id}`) && method === 'GET') {
        return { ok: true, json: async () => odu15FormatDef };
      }

      if (requestUrl.includes('/api/tournaments/tour-1/apply-format') && method === 'POST') {
        applyUrls.push(requestUrl);
        const body = JSON.parse(options.body || '{}');

        if (requestUrl.includes('force=true')) {
          appliedFormatId = body.formatId;
          return { ok: true, json: async () => ({ format: { id: body.formatId }, pools: [] }) };
        }

        return {
          ok: false,
          status: 409,
          json: async () => ({
            message: 'Tournament already has pools or matches. Re-run with ?force=true to replace.',
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/reset') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            reset: true,
            tournamentId: 'tour-1',
            status: 'setup',
            deleted: { pools: 0, matches: 0, scoreboards: 0 },
          }),
        };
      }

      throw new Error(`Unhandled fetch URL: ${requestUrl} (${method})`);
    });

    render(<TournamentFormatAdmin />);

    expect(await screen.findByRole('heading', { name: 'Tournament Format' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply Format' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Init .* Pools/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Proposed Template')).not.toBeInTheDocument();
    expect(screen.queryByText('Current Applied Template')).not.toBeInTheDocument();
    expect(screen.queryByText('Team Bank')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/SRC Court 1/i)).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'Format Schedule Preview' })).toBeInTheDocument();
    expect(await screen.findByText('Gold 1 vs Gold 8')).toBeInTheDocument();
    expect(screen.getAllByText('Crossover').length).toBeGreaterThan(0);
    expect(screen.getAllByText('R4').length).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /ODU 15-Team Classic/i }));

    await waitFor(() => {
      expect(applyUrls.some((url) => url.includes('/api/tournaments/tour-1/apply-format'))).toBe(
        true
      );
      expect(applyUrls.some((url) => url.includes('?force=true'))).toBe(true);
    });
    expect(window.confirm).toHaveBeenCalled();
  });

  it('auto-selects and auto-applies when only one suggested format exists', async () => {
    const applyBodies = [];
    const teams = Array.from({ length: 14 }, (_, index) => ({
      _id: `team-${index + 1}`,
      name: `Team ${index + 1}`,
      shortName: `T${index + 1}`,
      orderIndex: index + 1,
    }));
    const activeCourts = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];
    let appliedFormatId = '';

    globalThis.fetch.mockImplementation(async (url, options = {}) => {
      const requestUrl = String(url);
      const method = options.method || 'GET';

      if (requestUrl.endsWith('/api/tournaments/tour-1') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            _id: 'tour-1',
            name: 'City Open',
            publicCode: 'ABC123',
            facilities: {
              SRC: ['SRC-1', 'SRC-2', 'SRC-3'],
              VC: ['VC-1', 'VC-2'],
            },
            settings: {
              format: {
                formatId: appliedFormatId || null,
                activeCourts,
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams') && method === 'GET') {
        return { ok: true, json: async () => teams };
      }

      if (
        requestUrl.includes('/api/tournament-formats/suggest?teamCount=14&courtCount=5') &&
        method === 'GET'
      ) {
        return {
          ok: true,
          json: async () => [
            {
              id: classic14FormatDef.id,
              name: classic14FormatDef.name,
              description: classic14FormatDef.description,
              supportedTeamCounts: classic14FormatDef.supportedTeamCounts,
              minCourts: classic14FormatDef.minCourts,
            },
          ],
        };
      }

      if (
        requestUrl.endsWith(`/api/tournament-formats/${classic14FormatDef.id}`) &&
        method === 'GET'
      ) {
        return { ok: true, json: async () => classic14FormatDef };
      }

      if (requestUrl.includes('/api/tournaments/tour-1/apply-format') && method === 'POST') {
        const body = JSON.parse(options.body || '{}');
        applyBodies.push(body);
        appliedFormatId = body.formatId;
        return { ok: true, json: async () => ({ format: { id: body.formatId }, pools: [] }) };
      }

      throw new Error(`Unhandled fetch URL: ${requestUrl} (${method})`);
    });

    render(<TournamentFormatAdmin />);

    await waitFor(() => {
      expect(
        applyBodies.some((body) => body.formatId === 'classic_14_mixedpools_crossover_gold8_silver6_v1')
      ).toBe(true);
    });
    expect(screen.queryByRole('button', { name: 'Apply Format' })).not.toBeInTheDocument();
  });
});
