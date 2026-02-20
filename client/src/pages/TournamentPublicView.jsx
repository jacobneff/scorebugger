import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  formatRoundBlockStartTime,
  formatSetRecord,
  mapCourtLabel,
  sortPhase1Pools,
} from '../utils/phase1.js';
import {
  formatSetSummaryWithScores,
  normalizeCompletedSetScores,
  resolveCompletedSetScores,
  toSetSummaryFromLiveSummary,
  toSetSummaryFromScoreSummary,
} from '../utils/matchSetSummary.js';

const PLAYOFF_BRACKET_LABELS = {
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
};
const PLAYOFF_OVERALL_SEED_OFFSETS = Object.freeze({
  gold: 0,
  silver: 5,
  bronze: 10,
});
const TOURNAMENT_DETAILS_DEFAULTS = Object.freeze({
  specialNotes: '',
  foodInfo: {
    text: '',
    linkUrl: '',
  },
  facilitiesInfo: '',
  parkingInfo: '',
  mapImageUrls: [],
});
const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';
const CROSSOVER_STAGE_KEY = 'crossover';
const OVERVIEW_STAGE_KEYS = ['poolPlay1', CROSSOVER_STAGE_KEY];

const normalizePools = (pools) =>
  sortPhase1Pools(pools).map((pool) => ({
    ...pool,
    teamIds: Array.isArray(pool.teamIds)
      ? pool.teamIds.map((team) => ({
          _id: String(team._id),
          name: team.name || '',
          shortName: team.shortName || '',
          seed: team.seed ?? null,
        }))
      : [],
  }));

const normalizePlayoffPayload = (payload) => ({
  matches: Array.isArray(payload?.matches) ? payload.matches : [],
  brackets: payload?.brackets && typeof payload.brackets === 'object' ? payload.brackets : {},
  opsSchedule: Array.isArray(payload?.opsSchedule) ? payload.opsSchedule : [],
  bracketOrder: Array.isArray(payload?.bracketOrder) ? payload.bracketOrder : [],
});

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};

const formatTeamName = (team) => team?.shortName || team?.name || 'TBD';
const toIdString = (value) => {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value._id) {
    return String(value._id);
  }

  return String(value);
};
const uniqueValues = (values) => {
  const seen = new Set();
  const ordered = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    ordered.push(value);
  });
  return ordered;
};
const normalizeBracket = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';
const parseRoundRank = (roundKey) => {
  const normalized = String(roundKey || '').trim().toUpperCase();
  const matched = /^R(\d+)$/.exec(normalized);
  if (!matched) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(matched[1]);
};
const toTitleCase = (value) =>
  String(value || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');
const toOverallSeed = (bracket, bracketSeed) => {
  const seed = Number(bracketSeed);
  const offset = PLAYOFF_OVERALL_SEED_OFFSETS[normalizeBracket(bracket)];

  if (!Number.isFinite(seed) || !Number.isFinite(offset) || seed <= 0) {
    return null;
  }

  return offset + Math.floor(seed);
};
const formatTeamWithOverallSeed = (team, overallSeed) => {
  const hasResolvedTeam =
    team &&
    typeof team === 'object' &&
    (typeof team.shortName === 'string' || typeof team.name === 'string');
  const teamLabel = formatTeamName(team);

  if (!hasResolvedTeam || teamLabel === 'TBD') {
    return 'TBD';
  }

  return Number.isFinite(Number(overallSeed)) ? `${teamLabel} (#${Number(overallSeed)})` : teamLabel;
};
const formatPlayoffMatchSummary = (match, seedByTeamId) => {
  if (!match) {
    return 'TBD vs TBD';
  }

  const teamAId = toIdString(match.teamA?._id || match.teamAId);
  const teamBId = toIdString(match.teamB?._id || match.teamBId);
  const teamASeed = seedByTeamId.get(teamAId) ?? toOverallSeed(match.bracket, match.seedA);
  const teamBSeed = seedByTeamId.get(teamBId) ?? toOverallSeed(match.bracket, match.seedB);

  return `${formatTeamWithOverallSeed(match.teamA, teamASeed)} vs ${formatTeamWithOverallSeed(
    match.teamB,
    teamBSeed
  )}`;
};
const formatLiveSummary = (summary) => {
  if (!summary) {
    return '';
  }

  return `Live: ${formatSetSummaryWithScores(
    toSetSummaryFromLiveSummary(summary),
    summary?.completedSetScores
  )}`;
};

const getCourtMatchStatusMeta = (status) => {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (normalized === 'scheduled_tbd') {
    return {
      label: 'Scheduled / TBD',
      className: 'court-schedule-status court-schedule-status--tbd',
    };
  }

  if (normalized === 'live') {
    return {
      label: 'LIVE',
      className: 'court-schedule-status court-schedule-status--live',
    };
  }

  if (normalized === 'final') {
    return {
      label: 'FINAL',
      className: 'court-schedule-status court-schedule-status--final',
    };
  }

  if (normalized === 'ended') {
    return {
      label: 'ENDED',
      className: 'court-schedule-status court-schedule-status--ended',
    };
  }

  return {
    label: 'Scheduled',
    className: 'court-schedule-status court-schedule-status--scheduled',
  };
};

const normalizeCourtScheduleSlots = (payload) => {
  if (Array.isArray(payload?.slots) && payload.slots.length > 0) {
    return payload.slots;
  }

  if (!Array.isArray(payload?.matches)) {
    return Array.isArray(payload?.slots) ? payload.slots : [];
  }

  return payload.matches.map((match, index) => ({
    slotId: `${match?.matchId || 'match'}-${match?.roundBlock || index}`,
    kind: 'match',
    stageLabel: match?.phaseLabel || '',
    phase: match?.phase || null,
    phaseLabel: match?.phaseLabel || '',
    roundBlock: match?.roundBlock ?? null,
    timeLabel: '',
    status: match?.status || 'scheduled',
    matchId: match?.matchId || null,
    poolName: match?.poolName || null,
    matchupLabel: `${match?.teamA || 'TBD'} vs ${match?.teamB || 'TBD'}`,
    matchupReferenceLabel: null,
    refLabel:
      Array.isArray(match?.refs) && match.refs.length > 0
        ? match.refs.join(', ')
        : 'TBD',
    refReferenceLabel: null,
    scoreSummary: match?.score || null,
    setSummary: match?.score
      ? {
          setsA: Number(match.score?.setsA) || 0,
          setsB: Number(match.score?.setsB) || 0,
          setScores: [],
        }
      : null,
    teamA: match?.teamA ? { shortName: match.teamA, logoUrl: null } : null,
    teamB: match?.teamB ? { shortName: match.teamB, logoUrl: null } : null,
  }));
};
const formatCourtSlotScoreSummary = (slot) => {
  const scoreSummary = slot?.setSummary || slot?.scoreSummary;
  if (!scoreSummary) {
    return '';
  }

  const setScores = Array.isArray(slot?.setSummary?.setScores)
    ? slot.setSummary.setScores
    : Array.isArray(slot?.completedSetScores)
      ? slot.completedSetScores
      : [];

  return formatSetSummaryWithScores(toSetSummaryFromScoreSummary(scoreSummary), setScores);
};
const normalizeText = (value) => (typeof value === 'string' ? value : '');
const normalizeUrl = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeTournamentDetails = (details) => {
  const source = details && typeof details === 'object' ? details : {};
  const foodInfo = source.foodInfo && typeof source.foodInfo === 'object' ? source.foodInfo : {};
  const mapImageUrls = Array.isArray(source.mapImageUrls) ? source.mapImageUrls : [];

  return {
    specialNotes: normalizeText(source.specialNotes),
    foodInfo: {
      text: normalizeText(foodInfo.text),
      linkUrl: normalizeUrl(foodInfo.linkUrl),
    },
    facilitiesInfo: normalizeText(source.facilitiesInfo),
    parkingInfo: normalizeText(source.parkingInfo),
    mapImageUrls: mapImageUrls
      .map((url) => normalizeUrl(url))
      .filter(Boolean)
      .slice(0, 3),
  };
};

const normalizeLiveScoreSummary = (summary) => {
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  return {
    ...toSetSummaryFromLiveSummary(summary),
    completedSetScores: normalizeCompletedSetScores(summary?.completedSetScores),
  };
};

const formatLiveCardScoreSummary = ({ summary, completedSetScores }) => {
  const normalized = summary;
  if (!normalized) {
    return '';
  }

  return formatSetSummaryWithScores(
    toSetSummaryFromScoreSummary(normalized),
    completedSetScores || normalized.completedSetScores
  );
};

const toSafeHttpUrl = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    return parsed.toString();
  } catch {
    return '';
  }
};

const renderInlineMarkdown = (text, keyPrefix) => {
  if (!text) {
    return text;
  }

  const nodes = [];
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  let cursor = 0;
  let match;
  let index = 0;

  while ((match = linkPattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    const safeHref = toSafeHttpUrl(match[2]);
    if (safeHref) {
      nodes.push(
        <a key={`${keyPrefix}-link-${index}`} href={safeHref} target="_blank" rel="noreferrer">
          {match[1]}
        </a>
      );
    } else {
      nodes.push(match[0]);
    }
    cursor = match.index + match[0].length;
    index += 1;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes.length > 0 ? nodes : text;
};

const renderBasicMarkdown = (markdown) => {
  const source = normalizeText(markdown);
  if (!source.trim()) {
    return null;
  }

  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let listItems = [];
  let blockIndex = 0;

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }

    blocks.push(
      <ul key={`md-list-${blockIndex}`} className="tournament-details-markdown-list">
        {listItems.map((item, itemIndex) => (
          <li key={`md-list-item-${blockIndex}-${itemIndex}`}>
            {renderInlineMarkdown(item, `md-list-${blockIndex}-${itemIndex}`)}
          </li>
        ))}
      </ul>
    );
    listItems = [];
    blockIndex += 1;
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    if (trimmed.startsWith('- ')) {
      listItems.push(trimmed.slice(2).trim());
      return;
    }

    flushList();

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length + 2;
      const HeadingTag = level === 3 ? 'h3' : level === 4 ? 'h4' : 'h5';
      blocks.push(
        <HeadingTag key={`md-heading-${blockIndex}`} className="tournament-details-markdown-heading">
          {renderInlineMarkdown(headingMatch[2], `md-heading-${blockIndex}`)}
        </HeadingTag>
      );
      blockIndex += 1;
      return;
    }

    blocks.push(
      <p key={`md-paragraph-${blockIndex}`}>
        {renderInlineMarkdown(line, `md-paragraph-${blockIndex}`)}
      </p>
    );
    blockIndex += 1;
  });

  flushList();
  return blocks;
};

function TournamentPublicView() {
  const { publicCode } = useParams();
  const location = useLocation();
  const [tournament, setTournament] = useState(null);
  const [pools, setPools] = useState([]);
  const [overviewScheduleSlots, setOverviewScheduleSlots] = useState([]);
  const [playoffs, setPlayoffs] = useState({
    matches: [],
    brackets: {},
    opsSchedule: [],
  });
  const [courts, setCourts] = useState([]);
  const [selectedCourtCode, setSelectedCourtCode] = useState('');
  const [selectedCourt, setSelectedCourt] = useState(null);
  const [courtScheduleSlots, setCourtScheduleSlots] = useState([]);
  const [standingsByPhase, setStandingsByPhase] = useState({
    phase1: { pools: [], overall: [] },
    phase2: { pools: [], overall: [] },
    cumulative: { pools: [], overall: [] },
  });
  const [activeStandingsTab, setActiveStandingsTab] = useState('phase1');
  const [activeViewTab, setActiveViewTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [courtScheduleLoading, setCourtScheduleLoading] = useState(false);
  const [error, setError] = useState('');
  const [liveSummariesByMatchId, setLiveSummariesByMatchId] = useState({});
  const [details, setDetails] = useState(() => TOURNAMENT_DETAILS_DEFAULTS);
  const [liveMatches, setLiveMatches] = useState([]);

  const loadPublicData = useCallback(
    async ({ silent = false } = {}) => {
      if (!publicCode) {
        return;
      }

      if (!silent) {
        setLoading(true);
      }
      setError('');

      try {
        const [
          tournamentResponse,
          poolResponse,
          schedulePlanResponse,
          courtsResponse,
          phase1StandingsResponse,
          phase2StandingsResponse,
          cumulativeStandingsResponse,
          playoffsResponse,
          detailsResponse,
          liveMatchesResponse,
        ] = await Promise.all([
          fetch(`${API_URL}/api/tournaments/code/${publicCode}`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/phase1/pools`),
          fetch(
            `${API_URL}/api/tournaments/code/${publicCode}/schedule-plan?stageKeys=${encodeURIComponent(
              OVERVIEW_STAGE_KEYS.join(',')
            )}&kinds=match`
          ),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/courts`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/standings?phase=phase1`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/standings?phase=phase2`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/standings?phase=cumulative`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/playoffs`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/details`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/live`),
        ]);

        const [
          tournamentPayload,
          poolPayload,
          schedulePlanPayload,
          courtsPayload,
          phase1StandingsPayload,
          phase2StandingsPayload,
          cumulativeStandingsPayload,
          playoffsPayload,
          detailsPayload,
          liveMatchesPayload,
        ] = await Promise.all([
          tournamentResponse.json().catch(() => null),
          poolResponse.json().catch(() => null),
          schedulePlanResponse.json().catch(() => null),
          courtsResponse.json().catch(() => null),
          phase1StandingsResponse.json().catch(() => null),
          phase2StandingsResponse.json().catch(() => null),
          cumulativeStandingsResponse.json().catch(() => null),
          playoffsResponse.json().catch(() => null),
          detailsResponse.json().catch(() => null),
          liveMatchesResponse.json().catch(() => null),
        ]);

        if (!tournamentResponse.ok) {
          throw new Error(tournamentPayload?.message || 'Unable to load tournament');
        }
        if (!poolResponse.ok) {
          throw new Error(poolPayload?.message || 'Unable to load pools');
        }
        if (!schedulePlanResponse.ok) {
          throw new Error(schedulePlanPayload?.message || 'Unable to load schedule');
        }
        if (!courtsResponse.ok) {
          throw new Error(courtsPayload?.message || 'Unable to load courts');
        }
        if (!phase1StandingsResponse.ok) {
          throw new Error(phase1StandingsPayload?.message || 'Unable to load Pool Play 1 standings');
        }
        const tournamentFormatId =
          typeof tournamentPayload?.tournament?.settings?.format?.formatId === 'string'
            ? tournamentPayload.tournament.settings.format.formatId.trim()
            : '';
        const supportsPhase2 = tournamentFormatId === ODU_15_FORMAT_ID;
        if (!phase2StandingsResponse.ok && supportsPhase2) {
          throw new Error(phase2StandingsPayload?.message || 'Unable to load Pool Play 2 standings');
        }
        if (!cumulativeStandingsResponse.ok) {
          throw new Error(cumulativeStandingsPayload?.message || 'Unable to load cumulative standings');
        }
        if (!playoffsResponse.ok) {
          throw new Error(playoffsPayload?.message || 'Unable to load playoffs');
        }
        if (!detailsResponse.ok) {
          throw new Error(detailsPayload?.message || 'Unable to load details');
        }
        if (!liveMatchesResponse.ok) {
          throw new Error(liveMatchesPayload?.message || 'Unable to load live matches');
        }

        setTournament(tournamentPayload.tournament);
        setDetails(normalizeTournamentDetails(detailsPayload?.details));
        setLiveMatches(Array.isArray(liveMatchesPayload) ? liveMatchesPayload : []);
        setPools(normalizePools(poolPayload));
        setOverviewScheduleSlots(
          Array.isArray(schedulePlanPayload?.slots) ? schedulePlanPayload.slots : []
        );
        const nextCourts = Array.isArray(courtsPayload?.courts) ? courtsPayload.courts : [];
        setCourts(nextCourts);
        setSelectedCourtCode((currentCode) => {
          if (currentCode && nextCourts.some((court) => court.code === currentCode)) {
            return currentCode;
          }

          return nextCourts[0]?.code || '';
        });
        setPlayoffs(normalizePlayoffPayload(playoffsPayload));
        setStandingsByPhase({
          phase1: {
            pools: Array.isArray(phase1StandingsPayload?.pools) ? phase1StandingsPayload.pools : [],
            overall: Array.isArray(phase1StandingsPayload?.overall) ? phase1StandingsPayload.overall : [],
          },
          phase2: {
            pools:
              supportsPhase2 && Array.isArray(phase2StandingsPayload?.pools)
                ? phase2StandingsPayload.pools
                : [],
            overall:
              supportsPhase2 && Array.isArray(phase2StandingsPayload?.overall)
                ? phase2StandingsPayload.overall
                : [],
          },
          cumulative: {
            pools: Array.isArray(cumulativeStandingsPayload?.pools)
              ? cumulativeStandingsPayload.pools
              : [],
            overall: Array.isArray(cumulativeStandingsPayload?.overall)
              ? cumulativeStandingsPayload.overall
              : [],
          },
        });
      } catch (loadError) {
        setError(loadError.message || 'Unable to load public tournament view');
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [publicCode]
  );

  const loadCourtSchedule = useCallback(
    async ({ silent = false } = {}) => {
      if (!publicCode || !selectedCourtCode) {
        return;
      }

      if (!silent) {
        setCourtScheduleLoading(true);
      }

      try {
        const response = await fetch(
          `${API_URL}/api/tournaments/code/${publicCode}/courts/${selectedCourtCode}/schedule`
        );
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.message || 'Unable to load court schedule');
        }

        setSelectedCourt(payload?.court || null);
        setCourtScheduleSlots(normalizeCourtScheduleSlots(payload));
      } catch {
        setCourtScheduleSlots([]);
        if (!silent) {
          setSelectedCourt(null);
        }
      } finally {
        if (!silent) {
          setCourtScheduleLoading(false);
        }
      }
    },
    [publicCode, selectedCourtCode]
  );

  useEffect(() => {
    if (!publicCode) {
      setLoading(false);
      setError('Missing tournament code');
      setDetails(TOURNAMENT_DETAILS_DEFAULTS);
      setLiveMatches([]);
      return;
    }

    setLiveSummariesByMatchId({});
    loadPublicData();
  }, [loadPublicData, publicCode]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requestedView = params.get('view');
    const requestedCourtCode = params.get('court');

    if (['overview', 'playoffs', 'courts', 'live', 'details'].includes(requestedView)) {
      setActiveViewTab(requestedView);
    }

    if (typeof requestedCourtCode === 'string' && requestedCourtCode.trim()) {
      setSelectedCourtCode(requestedCourtCode.trim().toUpperCase());
    }
  }, [location.search]);

  useEffect(() => {
    if (!selectedCourtCode) {
      setSelectedCourt(null);
      setCourtScheduleSlots([]);
      return;
    }

    loadCourtSchedule();
  }, [loadCourtSchedule, selectedCourtCode]);

  const handleTournamentEvent = useCallback(
    (event) => {
      if (!event || typeof event !== 'object') {
        return;
      }

      if (event.type === 'SCOREBOARD_SUMMARY') {
        const matchId = event.data?.matchId;

        if (!matchId) {
          return;
        }

        setLiveSummariesByMatchId((previous) => ({
          ...previous,
          [matchId]: event.data,
        }));
        return;
      }

      loadPublicData({ silent: true });

      if (activeViewTab === 'courts' && selectedCourtCode) {
        loadCourtSchedule({ silent: true });
      }
    },
    [activeViewTab, loadCourtSchedule, loadPublicData, selectedCourtCode]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode || publicCode,
    onEvent: handleTournamentEvent,
  });

  const formatId =
    typeof tournament?.settings?.format?.formatId === 'string'
      ? tournament.settings.format.formatId.trim()
      : '';
  const supportsPhase2 = formatId === ODU_15_FORMAT_ID;
  const phase1Label = supportsPhase2 ? 'Pool Play 1' : 'Pool Play';
  const phase2Label = 'Pool Play 2';
  const scheduleSlots = useMemo(
    () =>
      (Array.isArray(overviewScheduleSlots) ? overviewScheduleSlots : []).filter(
        (slot) => String(slot?.kind || 'match').trim() === 'match'
      ),
    [overviewScheduleSlots]
  );
  const scheduleLookup = useMemo(() => {
    const lookup = {};
    scheduleSlots.forEach((slot) => {
      const roundBlock = Number(slot?.roundBlock);
      const courtCode = typeof slot?.courtCode === 'string' ? slot.courtCode.trim() : '';
      if (!Number.isFinite(roundBlock) || roundBlock <= 0 || !courtCode) {
        return;
      }

      lookup[`${Math.floor(roundBlock)}-${courtCode.toUpperCase()}`] = slot;
    });
    return lookup;
  }, [scheduleSlots]);
  const scheduleRoundBlocks = useMemo(() => {
    const uniqueRoundBlocks = Array.from(
      new Set(
        scheduleSlots
          .map((slot) => Number(slot?.roundBlock))
          .filter((roundBlock) => Number.isFinite(roundBlock) && roundBlock > 0)
      )
    ).sort((left, right) => left - right);
    return uniqueRoundBlocks;
  }, [scheduleSlots]);
  const scheduleCourts = useMemo(() => {
    const usedCourts = uniqueValues(
      scheduleSlots
        .map((slot) => (typeof slot?.courtCode === 'string' ? slot.courtCode.trim().toUpperCase() : ''))
        .filter(Boolean)
    );
    const preferredCourts = Array.isArray(tournament?.settings?.format?.activeCourts)
      ? tournament.settings.format.activeCourts
      : [];
    const preferredCourtCodes = uniqueValues(
      preferredCourts
        .map((courtCode) => (typeof courtCode === 'string' ? courtCode.trim().toUpperCase() : ''))
        .filter(Boolean)
    );
    const orderedCourts = uniqueValues([
      ...preferredCourtCodes.filter((courtCode) => usedCourts.includes(courtCode)),
      ...usedCourts,
    ]);
    return orderedCourts;
  }, [scheduleSlots, tournament]);
  const hasCrossoverMatches = useMemo(
    () =>
      scheduleSlots.some(
        (slot) => String(slot?.stageKey || '').trim() === CROSSOVER_STAGE_KEY
      ),
    [scheduleSlots]
  );
  const scheduleHeading = hasCrossoverMatches
    ? `${phase1Label} + Crossover Schedule`
    : `${phase1Label} Schedule`;
  const getPhaseLabel = useCallback(
    (phase) => {
      const normalizedPhase = String(phase || '').trim().toLowerCase();
      if (normalizedPhase === 'phase2') {
        return phase2Label;
      }
      if (normalizedPhase === 'playoffs') {
        return 'Playoffs';
      }
      return phase1Label;
    },
    [phase1Label, phase2Label]
  );
  const activeStandings =
    activeStandingsTab === 'phase2'
      ? standingsByPhase.phase2
      : activeStandingsTab === 'cumulative'
        ? standingsByPhase.cumulative
        : standingsByPhase.phase1;
  const liveCards = useMemo(
    () =>
      [...(Array.isArray(liveMatches) ? liveMatches : [])]
        .sort((left, right) => {
          const leftRound = Number.isFinite(Number(left?.roundBlock))
            ? Number(left.roundBlock)
            : Number.MAX_SAFE_INTEGER;
          const rightRound = Number.isFinite(Number(right?.roundBlock))
            ? Number(right.roundBlock)
            : Number.MAX_SAFE_INTEGER;

          if (leftRound !== rightRound) {
            return leftRound - rightRound;
          }

          return String(left?.courtLabel || left?.courtCode || '').localeCompare(
            String(right?.courtLabel || right?.courtCode || '')
          );
        })
        .map((match) => ({
          ...match,
          resolvedScoreSummary:
            normalizeLiveScoreSummary(liveSummariesByMatchId[match?.matchId]) ||
            normalizeLiveScoreSummary(match?.scoreSummary) ||
            toSetSummaryFromScoreSummary(match?.scoreSummary),
          resolvedCompletedSetScores: (() => {
            const liveCompletedSetScores = normalizeCompletedSetScores(
              liveSummariesByMatchId[match?.matchId]?.completedSetScores
            );
            return liveCompletedSetScores.length > 0
              ? liveCompletedSetScores
              : resolveCompletedSetScores(match);
          })(),
        })),
    [liveMatches, liveSummariesByMatchId]
  );
  const hasSpecialNotes = Boolean(details?.specialNotes?.trim());
  const hasFacilitiesInfo = Boolean(details?.facilitiesInfo?.trim());
  const hasParkingInfo = Boolean(details?.parkingInfo?.trim());
  const hasFoodText = Boolean(details?.foodInfo?.text?.trim());
  const hasFoodLink = Boolean(details?.foodInfo?.linkUrl?.trim());
  const safeFoodLinkUrl = toSafeHttpUrl(details?.foodInfo?.linkUrl);
  const hasFood = hasFoodText || hasFoodLink;
  const hasMaps = Array.isArray(details?.mapImageUrls) && details.mapImageUrls.length > 0;
  const hasAnyDetails =
    hasSpecialNotes || hasFacilitiesInfo || hasParkingInfo || hasFood || hasMaps;

  useEffect(() => {
    if (!supportsPhase2 && activeStandingsTab === 'phase2') {
      setActiveStandingsTab('phase1');
    }
  }, [activeStandingsTab, supportsPhase2]);

  if (loading) {
    return (
      <main className="container">
        <section className="card phase1-public-card">
          <p className="subtle">Loading tournament schedule...</p>
        </section>
      </main>
    );
  }

  if (error) {
    return (
      <main className="container">
        <section className="card phase1-public-card">
          <h1 className="title">Tournament View</h1>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="card phase1-public-card">
        <h1 className="title">{tournament?.name || 'Tournament'}</h1>
        <p className="subtitle">Live tournament schedule and standings</p>

        <div className="phase1-admin-actions">
          <button
            className={activeViewTab === 'live' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('live')}
          >
            Live
          </button>
          <button
            className={activeViewTab === 'overview' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('overview')}
          >
            Pools + Standings
          </button>
          <button
            className={activeViewTab === 'details' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('details')}
          >
            Details
          </button>
          <button
            className={activeViewTab === 'playoffs' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('playoffs')}
          >
            Playoffs
          </button>
          <button
            className={activeViewTab === 'courts' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('courts')}
          >
            Courts
          </button>
        </div>

        {activeViewTab === 'live' ? (
          <section className="tournament-live-view">
            <h2 className="secondary-title">Live Matches</h2>
            {liveCards.length === 0 ? (
              <p className="subtle">No matches are live right now.</p>
            ) : (
              <div className="tournament-live-list">
                {liveCards.map((match) => {
                  const timeLabel =
                    match?.timeLabel || formatRoundBlockStartTime(match?.roundBlock, tournament) || '-';
                  const courtLabel = match?.courtLabel || mapCourtLabel(match?.courtCode) || 'Court TBD';
                  const facilityLabel =
                    match?.facilityLabel || match?.facility || (match?.courtCode ? courtLabel : 'Facility TBD');
                  const scoreSummary = formatLiveCardScoreSummary({
                    summary: match?.resolvedScoreSummary,
                    completedSetScores: match?.resolvedCompletedSetScores,
                  });
                  return (
                    <article key={match?.matchId || `${match?.roundBlock}-${match?.courtCode}`} className="tournament-live-card">
                      <div className="tournament-live-card-header">
                        <p className="tournament-live-card-time">{timeLabel}</p>
                        <span className="tournament-live-pill">LIVE</span>
                      </div>
                      <p className="tournament-live-card-location">
                        {courtLabel} · {facilityLabel}
                      </p>
                      <p className="tournament-live-card-phase">
                        {getPhaseLabel(match?.phase)}
                        {match?.bracket ? ` · ${String(match.bracket).toUpperCase()}` : ''}
                      </p>
                      <p className="tournament-live-card-teams">
                        {match?.teamA?.shortName || 'TBD'} vs {match?.teamB?.shortName || 'TBD'}
                      </p>
                      {scoreSummary ? <p className="tournament-live-card-score">{scoreSummary}</p> : null}
                      {match?.scoreboardCode ? (
                        <a
                          className="tournament-live-card-link"
                          href={`/board/${match.scoreboardCode}/display`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View match
                        </a>
                      ) : (
                        <p className="subtle">No live scoreboard link available.</p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : activeViewTab === 'details' ? (
          <section className="tournament-public-details-view">
            <h2 className="secondary-title">Details</h2>
            {!hasAnyDetails ? (
              <p className="subtle">No details posted yet.</p>
            ) : (
              <div className="tournament-public-details-stack">
                {hasSpecialNotes ? (
                  <article className="tournament-public-details-section">
                    <h3>Special Notes</h3>
                    <div className="tournament-details-markdown">
                      {renderBasicMarkdown(details.specialNotes)}
                    </div>
                  </article>
                ) : null}

                {hasFacilitiesInfo ? (
                  <article className="tournament-public-details-section">
                    <h3>Facilities / Court Notes</h3>
                    <div className="tournament-details-markdown">
                      {renderBasicMarkdown(details.facilitiesInfo)}
                    </div>
                  </article>
                ) : null}

                {hasMaps ? (
                  <article className="tournament-public-details-section">
                    <h3>Maps</h3>
                    <div className="tournament-public-details-map-grid">
                      {details.mapImageUrls.map((url) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="tournament-public-details-map"
                        >
                          <img src={url} alt="Tournament map" loading="lazy" />
                        </a>
                      ))}
                    </div>
                  </article>
                ) : null}

                {hasFood ? (
                  <article className="tournament-public-details-section">
                    <h3>Food</h3>
                    {hasFoodText ? (
                      <div className="tournament-details-markdown">
                        {renderBasicMarkdown(details.foodInfo.text)}
                      </div>
                    ) : null}
                    {hasFoodLink && safeFoodLinkUrl ? (
                      <a href={safeFoodLinkUrl} target="_blank" rel="noreferrer">
                        Food details
                      </a>
                    ) : null}
                  </article>
                ) : null}

                {hasParkingInfo ? (
                  <article className="tournament-public-details-section">
                    <h3>Parking</h3>
                    <div className="tournament-details-markdown">
                      {renderBasicMarkdown(details.parkingInfo)}
                    </div>
                  </article>
                ) : null}
              </div>
            )}
          </section>
        ) : activeViewTab === 'overview' ? (
          <>
            <section>
              <h2 className="secondary-title">Pools</h2>
              <div className="phase1-pool-grid phase1-pool-grid--readonly">
                {pools.map((pool) => (
                  <article key={pool._id} className="phase1-pool-column">
                    <header className="phase1-pool-header">
                      <h3>Pool {pool.name}</h3>
                      <p>{pool.homeCourt ? mapCourtLabel(pool.homeCourt) : 'No home court'}</p>
                    </header>
                    <ul className="phase1-public-team-list">
                      {pool.teamIds.map((team) => (
                        <li key={team._id}>
                          <span>{team.name}</span>
                        </li>
                      ))}
                      {pool.teamIds.length === 0 && <li className="subtle">No teams assigned</li>}
                    </ul>
                  </article>
                ))}
              </div>
            </section>

            <section className="phase1-schedule">
              <h2 className="secondary-title">{scheduleHeading}</h2>
              {scheduleRoundBlocks.length === 0 || scheduleCourts.length === 0 ? (
                <p className="subtle">No schedule rows yet.</p>
              ) : (
                <div className="phase1-table-wrap">
                  <table className="phase1-schedule-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        {scheduleCourts.map((court) => (
                          <th key={court}>{mapCourtLabel(court)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {scheduleRoundBlocks.map((roundBlock) => (
                        <tr key={roundBlock}>
                          <th>{formatRoundBlockStartTime(roundBlock, tournament)}</th>
                          {scheduleCourts.map((court) => {
                            const slot = scheduleLookup[`${roundBlock}-${court}`];
                            const scoreboardKey = slot?.scoreboardCode || null;
                            const liveSummary = slot?.matchId
                              ? liveSummariesByMatchId[slot.matchId] || null
                              : null;
                            const stageLabel = slot?.poolName
                              ? `Pool ${slot.poolName}`
                              : slot?.stageLabel || getPhaseLabel(slot?.phase);
                            const hasMatchupReference =
                              typeof slot?.matchupReferenceLabel === 'string'
                              && slot.matchupReferenceLabel
                              && slot.matchupReferenceLabel !== slot?.matchupLabel;
                            const hasRefReference =
                              typeof slot?.refReferenceLabel === 'string'
                              && slot.refReferenceLabel
                              && slot.refReferenceLabel !== slot?.refLabel;
                            const scoreSummary = liveSummary
                              ? formatLiveSummary(liveSummary)
                              : formatCourtSlotScoreSummary(slot);

                            return (
                              <td key={`${roundBlock}-${court}`}>
                                {slot ? (
                                  <div className="phase1-match-cell">
                                    <p>
                                      <strong>{stageLabel || 'Stage'}</strong>
                                      {`: ${slot?.matchupLabel || 'TBD vs TBD'}`}
                                    </p>
                                    {hasMatchupReference ? (
                                      <p className="subtle">{slot.matchupReferenceLabel}</p>
                                    ) : null}
                                    <p>Ref: {slot?.refLabel || 'TBD'}</p>
                                    {hasRefReference ? (
                                      <p className="subtle">{slot.refReferenceLabel}</p>
                                    ) : null}
                                    {scoreSummary ? <p className="subtle">{scoreSummary}</p> : null}
                                    {scoreboardKey ? (
                                      <a
                                        href={`/board/${scoreboardKey}/display`}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Open Live Scoreboard
                                      </a>
                                    ) : (
                                      <span className="subtle">No scoreboard link</span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="subtle">-</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="phase1-standings">
              <h2 className="secondary-title">Standings</h2>
              <p className="subtle">Standings are based on finalized matches only.</p>
              <div className="phase1-admin-actions">
                <button
                  className={activeStandingsTab === 'phase1' ? 'primary-button' : 'secondary-button'}
                  type="button"
                  onClick={() => setActiveStandingsTab('phase1')}
                >
                  {phase1Label}
                </button>
                {supportsPhase2 && (
                  <button
                    className={activeStandingsTab === 'phase2' ? 'primary-button' : 'secondary-button'}
                    type="button"
                    onClick={() => setActiveStandingsTab('phase2')}
                  >
                    {phase2Label}
                  </button>
                )}
                <button
                  className={activeStandingsTab === 'cumulative' ? 'primary-button' : 'secondary-button'}
                  type="button"
                  onClick={() => setActiveStandingsTab('cumulative')}
                >
                  Cumulative
                </button>
              </div>

              {activeStandingsTab !== 'cumulative' && (
                <div className="phase1-standings-grid">
                  {activeStandings.pools.map((poolStanding) => (
                    <article key={poolStanding.poolName} className="phase1-standings-card">
                      <h3>Pool {poolStanding.poolName}</h3>
                      <div className="phase1-table-wrap">
                        <table className="phase1-standings-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Team</th>
                              <th>W-L</th>
                              <th>Sets</th>
                              <th>Pt Diff</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(poolStanding.teams || []).map((team) => (
                              <tr key={team.teamId}>
                                <td>{team.rank}</td>
                                <td>{team.shortName || team.name}</td>
                                <td>
                                  {team.matchesWon}-{team.matchesLost}
                                </td>
                                <td>{formatSetRecord(team)}</td>
                                <td>{formatPointDiff(team.pointDiff)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              <article className="phase1-standings-card phase1-standings-card--overall">
                <h3>
                  {activeStandingsTab === 'phase1'
                    ? `${phase1Label} Overall`
                    : activeStandingsTab === 'phase2'
                      ? `${phase2Label} Overall`
                      : 'Cumulative Overall'}
                </h3>
                <div className="phase1-table-wrap">
                  <table className="phase1-standings-table">
                    <thead>
                      <tr>
                        <th>Seed</th>
                        <th>Team</th>
                        <th>W-L</th>
                        <th>Sets</th>
                        <th>Pt Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(activeStandings.overall || []).map((team) => (
                        <tr key={team.teamId}>
                          <td>{team.rank}</td>
                          <td>{team.shortName || team.name}</td>
                          <td>
                            {team.matchesWon}-{team.matchesLost}
                          </td>
                          <td>{formatSetRecord(team)}</td>
                          <td>{formatPointDiff(team.pointDiff)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>
          </>
        ) : activeViewTab === 'courts' ? (
          <section className="court-schedule-page">
            <div className="court-schedule-selector">
              {courts.map((court) => (
                <button
                  key={court.code}
                  type="button"
                  className={
                    selectedCourtCode === court.code
                      ? 'primary-button court-schedule-court-button'
                      : 'secondary-button court-schedule-court-button'
                  }
                  onClick={() => setSelectedCourtCode(court.code)}
                >
                  {court.label || mapCourtLabel(court.code)}
                </button>
              ))}
            </div>

            {courtScheduleLoading ? (
              <p className="subtle">Loading court schedule...</p>
            ) : (
              <div className="court-schedule-list">
                {courtScheduleSlots.length === 0 ? (
                  <p className="subtle">No matches scheduled for this court yet.</p>
                ) : (
                  courtScheduleSlots.map((slot, index) => {
                    const liveSummary = slot?.matchId ? liveSummariesByMatchId[slot.matchId] || null : null;
                    const statusMeta = getCourtMatchStatusMeta(slot?.status);
                    const liveScoreSummary = liveSummary
                      ? formatSetSummaryWithScores(
                          toSetSummaryFromLiveSummary(liveSummary),
                          liveSummary?.completedSetScores
                        )
                      : '';
                    const scoreSummary = liveScoreSummary || formatCourtSlotScoreSummary(slot);
                    const timeLabel =
                      slot?.timeLabel
                      || formatRoundBlockStartTime(slot?.roundBlock, tournament)
                      || '-';
                    const stageLabel = slot?.stageLabel || slot?.phaseLabel || getPhaseLabel(slot?.phase);
                    const hasReferenceSubtitle =
                      typeof slot?.matchupReferenceLabel === 'string'
                      && slot.matchupReferenceLabel
                      && slot.matchupReferenceLabel !== slot?.matchupLabel;
                    const hasRefReferenceSubtitle =
                      typeof slot?.refReferenceLabel === 'string'
                      && slot.refReferenceLabel
                      && slot.refReferenceLabel !== slot?.refLabel;
                    const renderTeamChip = (team, fallbackLabel, key) => {
                      if (!team && !fallbackLabel) {
                        return null;
                      }

                      return (
                        <span key={key} className="court-schedule-team-chip">
                          {team?.logoUrl ? (
                            <img
                              src={team.logoUrl}
                              alt={`${team?.shortName || fallbackLabel || 'Team'} logo`}
                              className="court-schedule-team-logo"
                            />
                          ) : null}
                          <span>{team?.shortName || fallbackLabel || 'TBD'}</span>
                        </span>
                      );
                    };
                    const participantA = slot?.participants?.[0] || null;
                    const participantB = slot?.participants?.[1] || null;
                    const teamA = slot?.teamA || participantA?.team || null;
                    const teamB = slot?.teamB || participantB?.team || null;
                    const showResolvedTeams = Boolean(teamA || teamB);

                    return (
                      <article
                        key={`${slot?.slotId || slot?.matchId || 'slot'}-${slot?.roundBlock || index}`}
                        className="court-schedule-row"
                      >
                        <div className="court-schedule-time">{timeLabel}</div>
                        <div className="court-schedule-body">
                          <p className="court-schedule-stage">
                            <strong>{stageLabel || 'Stage'}</strong>
                            {`: ${slot?.matchupLabel || 'TBD vs TBD'}`}
                          </p>
                          {hasReferenceSubtitle ? (
                            <p className="court-schedule-reference">{slot.matchupReferenceLabel}</p>
                          ) : null}
                          {showResolvedTeams ? (
                            <div className="court-schedule-team-row">
                              {renderTeamChip(teamA, participantA?.label, 'team-a')}
                              <span className="subtle">vs</span>
                              {renderTeamChip(teamB, participantB?.label, 'team-b')}
                            </div>
                          ) : null}
                          <div className="court-schedule-meta">
                            <span className={statusMeta.className}>{statusMeta.label}</span>
                            <span>{slot?.phaseLabel || getPhaseLabel(slot?.phase)}</span>
                            {slot?.poolName ? <span>Pool {slot.poolName}</span> : null}
                          </div>
                          <p className="subtle">
                            Ref: {slot?.refLabel || 'TBD'}
                          </p>
                          {hasRefReferenceSubtitle ? (
                            <p className="court-schedule-reference">{slot.refReferenceLabel}</p>
                          ) : null}
                          <p className="subtle">
                            Location: {selectedCourt?.label || mapCourtLabel(selectedCourtCode)}
                          </p>
                          {scoreSummary ? <p className="subtle">{scoreSummary}</p> : null}
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            )}
          </section>
        ) : (
          <>
            <section className="phase1-schedule">
              <h2 className="secondary-title">Playoff Schedule</h2>
              {playoffs.opsSchedule.length === 0 ? (
                <p className="subtle">Playoffs have not been generated yet.</p>
              ) : (
                playoffs.opsSchedule.map((roundBlock) => (
                  <article key={roundBlock.roundBlock} className="phase1-standings-card">
                    <h3>{`${formatRoundBlockStartTime(roundBlock.roundBlock, tournament)} - ${roundBlock.label}`}</h3>
                    <div className="phase1-table-wrap">
                      <table className="phase1-schedule-table">
                        <thead>
                          <tr>
                            <th>Facility</th>
                            <th>Court</th>
                            <th>Match</th>
                            <th>Teams</th>
                            <th>Ref</th>
                            <th>Status</th>
                            <th>Live</th>
                          </tr>
                        </thead>
                        <tbody>
                          {roundBlock.slots.map((slot) => {
                            const match = playoffs.matches.find((entry) => entry._id === slot.matchId);
                            const scoreboardKey = match?.scoreboardCode || null;
                            const liveSummary = match ? liveSummariesByMatchId[match._id] : null;
                            return (
                              <tr key={`${roundBlock.roundBlock}-${slot.court}`}>
                                <td>{slot.facility}</td>
                                <td>{mapCourtLabel(slot.court)}</td>
                                <td>{slot.matchLabel}</td>
                                <td>{`${slot?.teams?.a || 'TBD'} vs ${slot?.teams?.b || 'TBD'}`}</td>
                                <td>{slot.refs.length > 0 ? slot.refs.join(', ') : 'TBD'}</td>
                                <td>
                                  {slot.status || 'empty'}
                                  {liveSummary && <p className="subtle">{formatLiveSummary(liveSummary)}</p>}
                                </td>
                                <td>
                                  {scoreboardKey ? (
                                    <a href={`/board/${scoreboardKey}/display`} target="_blank" rel="noreferrer">
                                      Open Live Scoreboard
                                    </a>
                                  ) : (
                                    <span className="subtle">-</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))
              )}
            </section>

            {playoffs.matches.length > 0 && (
              <section className="phase1-standings">
                <h2 className="secondary-title">Playoff Brackets</h2>
                <div className="playoff-bracket-grid">
                  {(Array.isArray(playoffs.bracketOrder) && playoffs.bracketOrder.length > 0
                    ? playoffs.bracketOrder
                    : Object.keys(playoffs.brackets || [])
                  ).map((bracketKey) => {
                    const bracket = normalizeBracket(bracketKey);
                    const bracketData = playoffs.brackets?.[bracket];
                    if (!bracketData) {
                      return null;
                    }

                    const roundOrder =
                      Array.isArray(bracketData.roundOrder) && bracketData.roundOrder.length > 0
                        ? bracketData.roundOrder
                        : Object.keys(bracketData.rounds || {}).sort((left, right) => {
                            const byRank = parseRoundRank(left) - parseRoundRank(right);
                            if (byRank !== 0) {
                              return byRank;
                            }
                            return left.localeCompare(right);
                          });

                    return (
                      <article key={bracket} className="phase1-standings-card playoff-bracket-card">
                        <h3>{bracketData.label || PLAYOFF_BRACKET_LABELS[bracket] || toTitleCase(bracket)}</h3>
                        <div className="playoff-seed-list">
                          {(bracketData.seeds || []).map((entry) => (
                            <p key={`${bracket}-seed-${entry.seed || entry.bracketSeed}`}>
                              #
                              {Number.isFinite(Number(entry?.overallSeed))
                                ? Number(entry.overallSeed)
                                : entry.seed || entry.bracketSeed}{' '}
                              {formatTeamName(entry.team)}
                            </p>
                          ))}
                        </div>
                        {(() => {
                          const seedByTeamId = new Map(
                            (bracketData?.seeds || [])
                              .map((entry) => {
                                const teamId = toIdString(entry?.teamId);
                                if (!teamId) {
                                  return null;
                                }

                                return [
                                  teamId,
                                  Number.isFinite(Number(entry?.overallSeed))
                                    ? Number(entry.overallSeed)
                                    : Number.isFinite(Number(entry?.seed))
                                      ? Number(entry.seed)
                                      : null,
                                ];
                              })
                              .filter(Boolean)
                          );

                          return roundOrder.map((roundKey) => (
                            <div key={`${bracket}-${roundKey}`} className="playoff-round-block">
                              <h4>{roundKey === 'R3' ? 'Final' : roundKey}</h4>
                              {(bracketData.rounds?.[roundKey] || []).map((match) => (
                                <div key={match._id} className="playoff-round-match">
                                  <p>{formatPlayoffMatchSummary(match, seedByTeamId)}</p>
                                  <p className="subtle">
                                    {mapCourtLabel(match.court)} • {match.status === 'final' ? 'Final' : 'Scheduled'}
                                  </p>
                                  {liveSummariesByMatchId[match._id] && (
                                    <p className="subtle">
                                      {formatLiveSummary(liveSummariesByMatchId[match._id])}
                                    </p>
                                  )}
                                  {match.result && (
                                    <p className="subtle">
                                      Sets {match.result.setsWonA}-{match.result.setsWonB} • Pts{' '}
                                      {match.result.pointsForA}-{match.result.pointsForB}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          ));
                        })()}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export default TournamentPublicView;
