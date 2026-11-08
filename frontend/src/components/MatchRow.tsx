import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type MatchAnalysis, type MatchSummary } from '../services/api';
import { TokenPrompt } from './TokenPrompt';
import { EnvBadge, fmtDate } from './ui';

const pct = (p: number): string => `${Math.round(p * 100)}%`;

// The forecast a row can show without leaving the list. The full reasoning, the model lineage and
// the forecast-vs-actual table stay on the match page; this is the headline and its confidence.
function RowForecast({ analysis, mode }: { analysis: MatchAnalysis; mode: string }) {
  const trend = analysis.resultTrend;
  return (
    <div className="col-span-4 rounded-md bg-slate-900/70 px-3 py-2 text-xs" aria-live="polite">
      {trend ? (
        <>
          <p className="font-semibold text-slate-200">
            {trend.lean}
            <span className="ml-2 font-mono font-normal text-slate-400">
              H {pct(trend.probabilities.home)} · D {pct(trend.probabilities.draw)} · A {pct(trend.probabilities.away)}
            </span>
          </p>
          <p className="mt-0.5 text-slate-400">{trend.explanation}</p>
        </>
      ) : (
        <p className="text-slate-400">No result forecast: the features this match needs are unavailable.</p>
      )}
      <p className="mt-1 text-[11px] text-slate-500">
        {mode === 'BACKTEST' ? 'Backtest at the pre-kickoff cutoff' : 'Forecast made before kickoff'} · {analysis.modelVersion} ·
        confidence {analysis.confidence.level.toLowerCase()} · {analysis.dataQuality.featuresAvailable}/{analysis.dataQuality.featuresTotal} features
      </p>
    </div>
  );
}

export function MatchRow({ match }: { match: MatchSummary }) {
  const played = match.homeScore !== null && match.awayScore !== null;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ analysis: MatchAnalysis; mode: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    setNeedsToken(false);
    try {
      const res = await api.runAnalysis(match.id);
      setResult({ analysis: res.analysis, mode: res.mode });
    } catch (e) {
      // A refusal is a missing token, not a failure worth a red error box.
      if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const action = played ? 'Backtest' : 'Predict';

  return (
    <li className="rounded-lg px-3 py-2 hover:bg-slate-800/70">
      <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-3">
        <Link to={`/matches/${encodeURIComponent(match.id)}`} className="truncate text-right text-sm hover:underline">
          {match.homeTeam.name}
        </Link>
        <Link to={`/matches/${encodeURIComponent(match.id)}`} className="min-w-20 text-center font-mono text-sm">
          {played ? `${match.homeScore} – ${match.awayScore}` : <span className="text-xs text-slate-400">{match.status === 'SCHEDULED' && new Date(match.matchDate) < new Date() ? 'awaiting result' : 'vs'}</span>}
        </Link>
        <Link to={`/matches/${encodeURIComponent(match.id)}`} className="truncate text-sm hover:underline">
          {match.awayTeam.name}
        </Link>
        <button
          type="button"
          onClick={run}
          disabled={running}
          aria-label={`${action} ${match.homeTeam.name} versus ${match.awayTeam.name}`}
          className="rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {running ? 'Running…' : result ? 'Re-run' : action}
        </button>

        <span className="col-span-4 flex items-center justify-center gap-2 text-[11px] text-slate-500">
          {fmtDate(match.matchDate)} · {match.competition.name} {match.round ? `· ${match.round}` : ''} <EnvBadge env={match.dataEnvironment} />
        </span>

        {needsToken && (
          <div className="col-span-4">
            <TokenPrompt onSaved={() => { setNeedsToken(false); void run(); }} />
          </div>
        )}
        {error && (
          <p role="alert" className="col-span-4 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}
        {result && <RowForecast analysis={result.analysis} mode={result.mode} />}
      </div>
    </li>
  );
}
