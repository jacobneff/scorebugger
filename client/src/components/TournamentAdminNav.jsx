import { MdApps } from 'react-icons/md';

function TournamentAdminNav({
  tournamentId,
  publicCode = '',
  activeMainTab = 'scheduling',
  scheduling = null,
}) {
  const id = typeof tournamentId === 'string' ? tournamentId.trim() : '';
  const normalizedPublicCode = typeof publicCode === 'string' ? publicCode.trim() : '';

  if (!id) {
    return null;
  }

  const mainTabs = [
    { key: 'teams', label: 'Team Setup', href: `/tournaments/${id}/teams` },
    { key: 'details', label: 'Details', href: `/tournaments/${id}/details` },
    { key: 'scheduling', label: 'Scheduling', href: `/tournaments/${id}/format` },
    { key: 'quick-scores', label: 'Quick Scores', href: `/tournaments/${id}/quick-scores` },
    {
      key: 'public',
      label: 'Public View',
      href: normalizedPublicCode ? `/t/${normalizedPublicCode}` : '',
    },
  ];

  const showSchedulingSubtabs = Boolean(scheduling && typeof scheduling === 'object');
  const showPhase2 = scheduling?.showPhase2 === true;
  const schedulingTabs = showSchedulingSubtabs
    ? [
        {
          key: 'format',
          label: 'Format',
          href: scheduling?.formatHref || `/tournaments/${id}/format`,
        },
        {
          key: 'phase1',
          label: scheduling?.phase1Label || 'Pool Play',
          href: scheduling?.phase1Href || `/tournaments/${id}/pool-play`,
        },
        ...(showPhase2
          ? [
              {
                key: 'phase2',
                label: scheduling?.phase2Label || 'Pool Play 2',
                href: scheduling?.phase2Href || `/tournaments/${id}/phase2`,
              },
            ]
          : []),
        {
          key: 'playoffs',
          label: 'Playoffs',
          href: scheduling?.playoffsHref || `/tournaments/${id}/playoffs`,
        },
      ]
    : [];

  return (
    <div className="tournament-admin-nav" aria-label="Tournament admin navigation">
      <div className="tournament-admin-nav-top">
        <a className="tournament-admin-services-link" href="/" aria-label="All services">
          <MdApps aria-hidden />
        </a>
        <a className="primary-button tournament-admin-hub-button" href={`/?tab=tournaments&tournamentId=${id}`}>
          Tournament Hub
        </a>
      </div>

      <nav className="tournament-admin-main-tabs" aria-label="Tournament main tabs">
        {mainTabs.map((tab) => {
          const isDisabled = !tab.href;
          const isActive = activeMainTab === tab.key;

          return (
            <a
              key={tab.key}
              className={`tournament-admin-main-tab ${isActive ? 'is-active' : ''} ${
                isDisabled ? 'is-disabled' : ''
              }`.trim()}
              href={tab.href || '#'}
              aria-current={isActive ? 'page' : undefined}
              aria-disabled={isDisabled ? 'true' : undefined}
              onClick={(event) => {
                if (isDisabled) {
                  event.preventDefault();
                }
              }}
            >
              {tab.label}
            </a>
          );
        })}
      </nav>

      {showSchedulingSubtabs && (
        <div className="tournament-admin-subtabs-shell">
          <p className="tournament-admin-subtabs-label">Scheduling</p>
          <nav className="tournament-admin-subtabs" aria-label="Scheduling subtabs">
            {schedulingTabs.map((tab) => (
              <a
                key={tab.key}
                className={`tournament-admin-subtab ${
                  scheduling?.activeSubTab === tab.key ? 'is-active' : ''
                }`}
                href={tab.href}
                aria-current={scheduling?.activeSubTab === tab.key ? 'page' : undefined}
              >
                {tab.label}
              </a>
            ))}
          </nav>
        </div>
      )}
    </div>
  );
}

export default TournamentAdminNav;
