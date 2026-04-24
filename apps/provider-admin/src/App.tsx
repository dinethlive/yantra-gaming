import { useEffect } from 'react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { AuthGuard } from './ui/AuthGuard';
import { Sidebar } from './ui/Sidebar';
import { AdminAudit } from './pages/AdminAudit';
import { Login } from './pages/Login';
import { Certificates } from './pages/Certificates';
import { NewOperator } from './pages/NewOperator';
import { OperatorDetail } from './pages/OperatorDetail';
import { Operators } from './pages/Operators';
import { Overview } from './pages/Overview';
import { ParSheet } from './pages/ParSheet';
import { ProofViewer } from './pages/ProofViewer';
import { RoundFinder } from './pages/RoundFinder';
import { Rtp } from './pages/Rtp';
import { Settings } from './pages/Settings';
import { Settlement } from './pages/Settlement';
import { Sla } from './pages/Sla';
import { useAuthStore } from './store/authStore';

function ProtectedLayout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  const hydrate = useAuthStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <AuthGuard>
            <ProtectedLayout />
          </AuthGuard>
        }
      >
        <Route index element={<Overview />} />
        <Route path="settlement" element={<Settlement />} />
        <Route path="rtp" element={<Rtp />} />
        <Route path="sla" element={<Sla />} />
        <Route path="certificates" element={<Certificates />} />
        <Route path="par-sheet" element={<ParSheet />} />
        <Route path="rounds" element={<RoundFinder />} />
        <Route path="pf" element={<ProofViewer />} />
        <Route path="audit" element={<AdminAudit />} />
        <Route path="settings" element={<Settings />} />
        <Route path="operators" element={<Operators />} />
        <Route path="operators/new" element={<NewOperator />} />
        <Route path="operators/:id" element={<OperatorDetail />} />
      </Route>
    </Routes>
  );
}
