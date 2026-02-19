import { useParams } from 'react-router-dom';

import TournamentsTab from '../components/TournamentsTab.jsx';
import { useAuth } from '../context/AuthContext.jsx';

function TournamentDetailsAdmin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();
  const tournamentId = typeof id === 'string' ? id.trim() : '';

  if (initializing) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading tournament details...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Tournament Details</h1>
          <p className="subtle">Sign in to edit tournament details.</p>
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
            <h1 className="title">Tournament Details</h1>
            <p className="subtitle">Update public notes, maps, and venue information.</p>
          </div>
          <div className="phase1-admin-actions">
            <a className="secondary-button" href={`/tournaments/${tournamentId}/teams`}>
              Team Setup
            </a>
            <a className="secondary-button" href={`/tournaments/${tournamentId}/format`}>
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
          mode="details"
        />
      </section>
    </main>
  );
}

export default TournamentDetailsAdmin;
