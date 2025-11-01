import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

import ScoreboardOverlay from '../components/ScoreboardOverlay.jsx';
import { useScoreboard } from '../hooks/useScoreboard.js';

function Display() {
  const { scoreboardId } = useParams();
  const { scoreboard, loading, error } = useScoreboard(scoreboardId);

  useEffect(() => {
    document.body.classList.add('overlay-mode');
    document.documentElement.classList.add('overlay-mode');

    return () => {
      document.body.classList.remove('overlay-mode');
      document.documentElement.classList.remove('overlay-mode');
    };
  }, []);

  if (loading) {
    return <div className="overlay-status">Loading scoreboard...</div>;
  }

  if (error) {
    return <div className="overlay-status overlay-status--error">{error}</div>;
  }

  if (!scoreboard) {
    return <div className="overlay-status">No scoreboard data found.</div>;
  }

  return (
    <div className="overlay-stage">
      <ScoreboardOverlay scoreboard={scoreboard} />
    </div>
  );
}

export default Display;
