import { useNavigate, useParams } from 'react-router-dom';
import ControlPanelView from '../components/ControlPanelView.jsx';

function ControlPanel() {
  const { scoreboardId } = useParams();
  const navigate = useNavigate();

  const handleScoreboardChange = (nextId) => {
    const cleaned = nextId?.trim();
    if (!cleaned) return;
    navigate(`/board/${cleaned.toUpperCase()}/control`);
  };

  return (
    <main className="container">
      <ControlPanelView
        scoreboardId={scoreboardId}
        onScoreboardChange={handleScoreboardChange}
      />
    </main>
  );
}

export default ControlPanel;
