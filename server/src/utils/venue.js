const crypto = require('crypto');

const DEFAULT_TOTAL_COURTS = 5;
const DEFAULT_FACILITY_NAME = 'Main Facility';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const toIdString = (value) => {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return String(value).trim();
};

const makeStableId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const normalizeFacilityName = (value, index) => {
  if (isNonEmptyString(value)) {
    return value.trim();
  }

  if (index === 0) {
    return DEFAULT_FACILITY_NAME;
  }

  return `Facility ${index + 1}`;
};

const normalizeCourtName = (value, index) => {
  if (isNonEmptyString(value)) {
    return value.trim();
  }

  return `Court ${index + 1}`;
};

function normalizeVenueFacilities(rawFacilities, options = {}) {
  const source = Array.isArray(rawFacilities) ? rawFacilities : [];
  const normalizedFacilities = source.map((facility, facilityIndex) => {
    const incomingFacilityId = toIdString(facility?.facilityId);
    const courts = Array.isArray(facility?.courts) ? facility.courts : [];

    return {
      facilityId: incomingFacilityId || makeStableId('facility'),
      name: normalizeFacilityName(facility?.name, facilityIndex),
      courts: courts.map((court, courtIndex) => {
        const incomingCourtId = toIdString(court?.courtId);
        const isEnabled = court?.isEnabled !== false;

        return {
          courtId: incomingCourtId || makeStableId('court'),
          name: normalizeCourtName(court?.name, courtIndex),
          isEnabled,
        };
      }),
    };
  });

  const withFallbackFacility =
    normalizedFacilities.length > 0
      ? normalizedFacilities
      : [
          {
            facilityId: makeStableId('facility'),
            name: DEFAULT_FACILITY_NAME,
            courts: [],
          },
        ];

  if (options.ensureAtLeastOneCourt) {
    const courtCount = countVenueCourts(withFallbackFacility);
    if (courtCount === 0) {
      withFallbackFacility[0].courts = [
        {
          courtId: makeStableId('court'),
          name: 'Court 1',
          isEnabled: true,
        },
      ];
    }
  }

  return withFallbackFacility;
}

function countVenueCourts(facilities, options = {}) {
  const source = Array.isArray(facilities) ? facilities : [];
  const enabledOnly = options.enabledOnly === true;

  return source.reduce((total, facility) => {
    const courts = Array.isArray(facility?.courts) ? facility.courts : [];
    return (
      total +
      courts.filter((court) => (enabledOnly ? court?.isEnabled !== false : true)).length
    );
  }, 0);
}

function buildDefaultVenue(totalCourts, options = {}) {
  const resolvedTotal = Number.isFinite(Number(totalCourts)) && Number(totalCourts) > 0
    ? Math.floor(Number(totalCourts))
    : DEFAULT_TOTAL_COURTS;
  const legacyCourtNames = Array.isArray(options.legacyCourtNames)
    ? options.legacyCourtNames.filter((entry) => isNonEmptyString(entry))
    : [];
  const facilityName = isNonEmptyString(options.facilityName)
    ? options.facilityName.trim()
    : DEFAULT_FACILITY_NAME;
  const facilityId = makeStableId('facility');

  const courts = Array.from({ length: resolvedTotal }, (_, index) => ({
    courtId: makeStableId('court'),
    name: legacyCourtNames[index] || `Court ${index + 1}`,
    isEnabled: true,
  }));

  return {
    facilities: [
      {
        facilityId,
        name: facilityName,
        courts,
      },
    ],
  };
}

function flattenVenueCourts(venue) {
  const facilities = Array.isArray(venue?.facilities) ? venue.facilities : [];
  const flattened = [];

  facilities.forEach((facility, facilityIndex) => {
    const facilityId = toIdString(facility?.facilityId) || makeStableId('facility');
    const facilityName = normalizeFacilityName(facility?.name, facilityIndex);
    const courts = Array.isArray(facility?.courts) ? facility.courts : [];

    courts.forEach((court, courtIndex) => {
      const courtId = toIdString(court?.courtId) || makeStableId('court');
      flattened.push({
        facilityId,
        facilityName,
        courtId,
        courtName: normalizeCourtName(court?.name, courtIndex),
        isEnabled: court?.isEnabled !== false,
      });
    });
  });

  return flattened;
}

function buildVenueCourtLookup(venue) {
  const byCourtId = new Map();
  const byCourtName = new Map();

  flattenVenueCourts(venue).forEach((court) => {
    byCourtId.set(court.courtId, court);
    byCourtName.set(String(court.courtName || '').trim().toLowerCase(), court);
  });

  return {
    byCourtId,
    byCourtName,
  };
}

function findCourtInVenue(venue, courtIdOrName) {
  const key = isNonEmptyString(courtIdOrName) ? courtIdOrName.trim() : '';
  if (!key) {
    return null;
  }

  const lookup = buildVenueCourtLookup(venue);
  const byId = lookup.byCourtId.get(key);
  if (byId) {
    return byId;
  }

  return lookup.byCourtName.get(key.toLowerCase()) || null;
}

function getEnabledCourts(venue) {
  return flattenVenueCourts(venue).filter((court) => court.isEnabled !== false);
}

function venueToLegacyCourtNames(venue, options = {}) {
  const enabledOnly = options.enabledOnly !== false;
  const source = enabledOnly ? getEnabledCourts(venue) : flattenVenueCourts(venue);
  return source.map((court) => court.courtName).filter(Boolean);
}

module.exports = {
  DEFAULT_TOTAL_COURTS,
  buildDefaultVenue,
  buildVenueCourtLookup,
  countVenueCourts,
  findCourtInVenue,
  flattenVenueCourts,
  getEnabledCourts,
  normalizeVenueFacilities,
  venueToLegacyCourtNames,
};
