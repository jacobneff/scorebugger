import { useParams, useSearchParams } from 'react-router-dom';

import TournamentMatchControlView from '../components/TournamentMatchControlView.jsx';
import { normalizeMatchStatus } from '../utils/tournamentMatchControl.js';

function TournamentMatchControl() {
  const { matchId, scoreboardId } = useParams();
  const [searchParams] = useSearchParams();

  const initialStatus = normalizeMatchStatus(searchParams.get('status'));

  return (
    <main className="container">
      <TournamentMatchControlView
        matchId={matchId}
        scoreboardId={scoreboardId}
        initialStatus={initialStatus}
      />
    </main>
  );
}

export default TournamentMatchControl;
