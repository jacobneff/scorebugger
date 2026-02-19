import { Navigate, Route, Routes } from 'react-router-dom';

import ControlPanel from './pages/ControlPanel.jsx';
import Display from './pages/Display.jsx';
import Home from './pages/Home.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import TournamentMatchControl from './pages/TournamentMatchControl.jsx';
import TournamentDetailsAdmin from './pages/TournamentDetailsAdmin.jsx';
import TournamentFormatAdmin from './pages/TournamentFormatAdmin.jsx';
import TournamentPhase1Admin from './pages/TournamentPhase1Admin.jsx';
import TournamentPhase2Admin from './pages/TournamentPhase2Admin.jsx';
import TournamentPlayoffsAdmin from './pages/TournamentPlayoffsAdmin.jsx';
import TournamentQuickScoresAdmin from './pages/TournamentQuickScoresAdmin.jsx';
import TournamentTeamsAdmin from './pages/TournamentTeamsAdmin.jsx';
import TournamentPublicView from './pages/TournamentPublicView.jsx';
import TournamentTeamPublicView from './pages/TournamentTeamPublicView.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/board/:scoreboardId/control" element={<ControlPanel />} />
      <Route path="/board/:scoreboardId/display" element={<Display />} />
      <Route
        path="/tournaments/matches/:matchId/control/:scoreboardId"
        element={<TournamentMatchControl />}
      />
      <Route path="/tournaments/:id/details" element={<TournamentDetailsAdmin />} />
      <Route path="/tournaments/:id/teams" element={<TournamentTeamsAdmin />} />
      <Route path="/tournaments/:id/format" element={<TournamentFormatAdmin />} />
      <Route path="/tournaments/:id/phase1" element={<TournamentPhase1Admin />} />
      <Route path="/tournaments/:id/phase2" element={<TournamentPhase2Admin />} />
      <Route path="/tournaments/:id/playoffs" element={<TournamentPlayoffsAdmin />} />
      <Route path="/tournaments/:id/quick-scores" element={<TournamentQuickScoresAdmin />} />
      <Route path="/t/:tournamentCode/team/:teamCode" element={<TournamentTeamPublicView />} />
      <Route path="/t/:publicCode" element={<TournamentPublicView />} />
      <Route path="/auth/verify" element={<VerifyEmail />} />
      <Route path="/auth/reset-password" element={<ResetPassword />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
