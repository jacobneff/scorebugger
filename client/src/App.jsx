import { Navigate, Route, Routes } from 'react-router-dom';

import ControlPanel from './pages/ControlPanel.jsx';
import Display from './pages/Display.jsx';
import Home from './pages/Home.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/board/:scoreboardId/control" element={<ControlPanel />} />
      <Route path="/board/:scoreboardId/display" element={<Display />} />
      <Route path="/auth/verify" element={<VerifyEmail />} />
      <Route path="/auth/reset-password" element={<ResetPassword />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
