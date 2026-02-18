import { useParams } from 'react-router-dom';

import TournamentsTab from '../components/TournamentsTab.jsx';
import { useAuth } from '../context/AuthContext.jsx';

function TournamentTeamsAdmin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();
  const tournamentId = typeof id === 'string' ? id.trim() : '';

  if (initializing) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading team setup...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Team Setup</h1>
          <p className="subtle">Sign in to manage tournament teams.</p>
          <a className="primary-button" href="/?mode=signin">
            Sign In
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="card phase1-admin-card">
        <div className="phase1-admin-header">
          <div>
            <h1 className="title">Team Setup</h1>
            <p className="subtitle">Manage teams, ordering, and team public links.</p>
          </div>
          <div className="phase1-admin-actions">
            <a className="secondary-button" href={`/tournaments/${tournamentId}/details`}>
              Tournament Details
            </a>
            <a className="secondary-button" href={`/tournaments/${tournamentId}/phase1`}>
              Scheduling
            </a>
            <a className="secondary-button" href={`/tournaments/${tournamentId}/quick-scores`}>
              Quick Scores
            </a>
          </div>
        </div>
        <TournamentsTab
          user={user}
          token={token}
          initialTournamentId={tournamentId}
          mode="teams"
        />
      </section>
    </main>
  );
}

export default TournamentTeamsAdmin;
