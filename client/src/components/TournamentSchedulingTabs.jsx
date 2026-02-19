function TournamentSchedulingTabs({ tournamentId, activeTab, showPhase2 = true }) {
  const id = typeof tournamentId === 'string' ? tournamentId.trim() : '';

  if (!id) {
    return null;
  }

  const tabs = [
    {
      key: 'format',
      label: 'Format',
      href: `/tournaments/${id}/format`,
    },
    {
      key: 'phase1',
      label: 'Pool Play 1',
      href: `/tournaments/${id}/phase1`,
    },
    {
      key: 'playoffs',
      label: 'Playoffs',
      href: `/tournaments/${id}/playoffs`,
    },
  ];

  if (showPhase2) {
    tabs.splice(2, 0, {
      key: 'phase2',
      label: 'Pool Play 2',
      href: `/tournaments/${id}/phase2`,
    });
  }

  return (
    <div className="tournament-scheduling-nav">
      <nav className="tournament-scheduling-tabs" aria-label="Scheduling tabs">
        {tabs.map((tab) => (
          <a
            key={tab.key}
            className={`tournament-scheduling-tab ${
              activeTab === tab.key ? 'is-active' : ''
            }`}
            href={tab.href}
            aria-current={activeTab === tab.key ? 'page' : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      <div className="tournament-scheduling-links">
        <a className="tournament-scheduling-link" href={`/tournaments/${id}/details`}>
          Tournament Details
        </a>
        <a className="tournament-scheduling-link" href={`/tournaments/${id}/teams`}>
          Team Setup
        </a>
        <a className="tournament-scheduling-link" href={`/?tab=tournaments&tournamentId=${id}`}>
          Tournament Hub
        </a>
        <a className="tournament-scheduling-link" href={`/tournaments/${id}/quick-scores`}>
          Quick Scores
        </a>
      </div>
    </div>
  );
}

export default TournamentSchedulingTabs;
