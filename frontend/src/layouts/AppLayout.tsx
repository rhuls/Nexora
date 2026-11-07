import { NavLink, Outlet } from 'react-router-dom';
import { AdminToken } from '../components/AdminToken';

const NAV = [
  ['/', 'Dashboard'],
  ['/matches', 'Matches'],
  ['/teams', 'Teams'],
  ['/debate', 'Debate'],
  ['/blackjack', 'Blackjack'],
  ['/performance', 'Model Performance'],
  ['/evolution', 'Model Evolution'],
  ['/quality', 'Data Quality'],
] as const;

export function AppLayout() {
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-emerald-500 focus:px-3 focus:py-1 focus:text-slate-950">
        Skip to content
      </a>
      <header className="border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-xl font-black tracking-[0.35em] text-emerald-400">NEXORA</p>
            <p className="text-xs text-slate-400">Understand the game through data.</p>
          </div>
          <div className="flex items-center gap-3">
            <AdminToken />
          </div>
          <nav aria-label="Main">
            <ul className="flex flex-wrap gap-1 text-sm">
              {NAV.map(([to, label]) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    end={to === '/'}
                    className={({ isActive }) => `rounded-md px-3 py-1.5 ${isActive ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-300 hover:bg-slate-800'}`}
                  >
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-6 py-8">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-7xl px-6 pb-8 text-xs text-slate-600">
        Nexora is a football statistics and model-evaluation tool. Forecasts are research outputs, not recommendations.
      </footer>
    </div>
  );
}
