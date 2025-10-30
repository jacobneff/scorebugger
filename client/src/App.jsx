import { Navigate, Route, Routes } from 'react-router-dom';

import ControlPanel from './pages/ControlPanel.jsx';
import Display from './pages/Display.jsx';
import Home from './pages/Home.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/board/:scoreboardId/control" element={<ControlPanel />} />
      <Route path="/board/:scoreboardId/display" element={<Display />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
