import { Link, Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { BlackjackPage } from './pages/BlackjackPage';
import { DashboardPage } from './pages/DashboardPage';
import { DebatePage } from './pages/DebatePage';
import { EvolutionPage } from './pages/EvolutionPage';
import { MatchPage } from './pages/MatchPage';
import { MatchesPage } from './pages/MatchesPage';
import { PerformancePage } from './pages/PerformancePage';
import { QualityPage } from './pages/QualityPage';
import { PlayerPage, TeamPage, TeamsPage } from './pages/TeamPages';

function NotFound() {
  return (
    <p className="text-sm text-slate-400">
      Page not found. <Link className="text-emerald-400 underline" to="/">Back to the dashboard</Link>
    </p>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="matches" element={<MatchesPage />} />
        <Route path="matches/:id" element={<MatchPage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="teams/:id" element={<TeamPage />} />
        <Route path="players/:id" element={<PlayerPage />} />
        <Route path="debate" element={<DebatePage />} />
        <Route path="blackjack" element={<BlackjackPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="evolution" element={<EvolutionPage />} />
        <Route path="quality" element={<QualityPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
