import { Link } from 'react-router-dom';
import type { MatchSummary } from '../services/api';
import { EnvBadge, fmtDate } from './ui';

export function MatchRow({ match }: { match: MatchSummary }) {
  const played = match.homeScore !== null && match.awayScore !== null;
  return (
    <li>
      <Link
        to={`/matches/${encodeURIComponent(match.id)}`}
        className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-800/70"
      >
        <span className="truncate text-right text-sm">{match.homeTeam.name}</span>
        <span className="min-w-20 text-center font-mono text-sm">
          {played ? `${match.homeScore} – ${match.awayScore}` : <span className="text-xs text-slate-400">{match.status === 'SCHEDULED' && new Date(match.matchDate) < new Date() ? 'awaiting result' : 'vs'}</span>}
        </span>
        <span className="flex items-center gap-2 truncate text-sm">
          {match.awayTeam.name}
        </span>
        <span className="col-span-3 flex items-center justify-center gap-2 text-[11px] text-slate-500">
          {fmtDate(match.matchDate)} · {match.competition.name} {match.round ? `· ${match.round}` : ''} <EnvBadge env={match.dataEnvironment} />
        </span>
      </Link>
    </li>
  );
}
