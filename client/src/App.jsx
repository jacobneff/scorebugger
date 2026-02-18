import { Navigate, Route, Routes } from 'react-router-dom';

import ControlPanel from './pages/ControlPanel.jsx';
import Display from './pages/Display.jsx';
import Home from './pages/Home.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import TournamentPhase1Admin from './pages/TournamentPhase1Admin.jsx';
import TournamentPhase2Admin from './pages/TournamentPhase2Admin.jsx';
import TournamentPublicView from './pages/TournamentPublicView.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/board/:scoreboardId/control" element={<ControlPanel />} />
      <Route path="/board/:scoreboardId/display" element={<Display />} />
      <Route path="/tournaments/:id/phase1" element={<TournamentPhase1Admin />} />
      <Route path="/tournaments/:id/phase2" element={<TournamentPhase2Admin />} />
      <Route path="/t/:publicCode" element={<TournamentPublicView />} />
      <Route path="/auth/verify" element={<VerifyEmail />} />
      <Route path="/auth/reset-password" element={<ResetPassword />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
