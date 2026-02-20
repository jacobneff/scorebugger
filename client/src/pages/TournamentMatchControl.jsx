import { useParams, useSearchParams } from 'react-router-dom';

import TournamentMatchControlView from '../components/TournamentMatchControlView.jsx';
import {
  normalizeLifecycleTimestamp,
  normalizeMatchStatus,
} from '../utils/tournamentMatchControl.js';

function TournamentMatchControl() {
  const { matchId, scoreboardId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialStatus = normalizeMatchStatus(searchParams.get('status'));
  const initialStartedAt = normalizeLifecycleTimestamp(searchParams.get('startedAt'));
  const initialEndedAt = normalizeLifecycleTimestamp(searchParams.get('endedAt'));

  const handleLifecycleChange = ({ status, startedAt, endedAt }) => {
    const query = new URLSearchParams();
    query.set('status', normalizeMatchStatus(status, initialStatus));

    const normalizedStartedAt = normalizeLifecycleTimestamp(startedAt);
    const normalizedEndedAt = normalizeLifecycleTimestamp(endedAt);

    if (normalizedStartedAt) {
      query.set('startedAt', normalizedStartedAt);
    }

    if (normalizedEndedAt) {
      query.set('endedAt', normalizedEndedAt);
    }

    setSearchParams(query, { replace: true });
  };

  return (
    <main className="container">
      <TournamentMatchControlView
        matchId={matchId}
        scoreboardId={scoreboardId}
        initialStatus={initialStatus}
        initialStartedAt={initialStartedAt}
        initialEndedAt={initialEndedAt}
        onLifecycleChange={handleLifecycleChange}
      />
    </main>
  );
}

export default TournamentMatchControl;
