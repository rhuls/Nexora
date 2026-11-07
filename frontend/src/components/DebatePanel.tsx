import { useState } from 'react';
import { Card, ErrorBox, Loading, RecommendationBadge, Unavailable, fmtDate, pct } from './ui';
import { useApi } from '../hooks/useApi';
import { ApiError, api, type DebateTranscript, type DebateVerdict } from '../services/api';
import { TokenPrompt } from './TokenPrompt';

const MARKET_LABEL: Record<string, string> = { MATCH_RESULT: 'Match result', OVER_UNDER_25: 'Over/under 2.5', BTTS: 'Both teams to score' };

const SEVERITY_STYLE: Record<string, string> = {
  VETO: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  CONCERN: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  NOTE: 'border-slate-700 bg-slate-800/40 text-slate-300',
};

function VerdictCard({ verdict }: { verdict: DebateVerdict }) {
  const probabilities = verdict.probabilities;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">{MARKET_LABEL[verdict.market] ?? verdict.market}</h3>
        <RecommendationBadge value={verdict.recommendation} />
      </div>

      {probabilities === null ? (
        <p className="mt-3"><Unavailable /></p>
      ) : (
        <dl className="mt-3 flex flex-wrap gap-4">
          {Object.entries(probabilities).map(([outcome, p]) => (
            <div key={outcome}>
              <dt className="text-[10px] uppercase tracking-widest text-slate-500">{outcome}</dt>
              <dd className="font-mono text-base">{pct(p)}</dd>
            </div>
          ))}
        </dl>
      )}

      <dl className="mt-3 flex flex-wrap gap-4 text-xs">
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Edge vs market</dt>
          <dd className="font-mono">{verdict.edge === null ? <Unavailable label="NO BASELINE" /> : `${verdict.edge > 0 ? '+' : ''}${verdict.edge.toFixed(3)}`}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Confidence</dt>
          <dd className="font-mono">{verdict.confidence}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Suggested stake</dt>
          <dd className="font-mono">{verdict.stakePct === null ? '—' : `${verdict.stakePct}%`}</dd>
        </div>
      </dl>

      <p className="mt-3 text-sm text-slate-300">{verdict.reasoning}</p>
      <p className="mt-1 text-xs text-slate-500">{verdict.stakeReason}</p>

      {verdict.unresolvedObjections.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-slate-400">
            {verdict.unresolvedObjections.length} unresolved objection(s)
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-400">
            {verdict.unresolvedObjections.map((o, i) => <li key={i}>• {o}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function Transcript({ transcript }: { transcript: DebateTranscript }) {
  const { one, two, four } = transcript.rounds;
  const known = one.evidence.facts.filter((f) => !f.unavailable);
  const missing = one.evidence.facts.filter((f) => f.unavailable);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        {transcript.verdicts.map((v) => <VerdictCard key={v.market} verdict={v} />)}
      </div>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Round 1 — Scout and Copycat</h3>
        <p className="mt-2 text-xs text-slate-500">
          Market baseline: <span className="font-mono text-slate-300">{one.baseline.status}</span>. {one.baseline.reason}
        </p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="text-[10px] uppercase tracking-widest text-slate-500">Established ({known.length})</h4>
            <ul className="mt-1 space-y-1 text-sm text-slate-300">
              {known.slice(0, 14).map((f) => (
                <li key={f.key} className="flex justify-between gap-3">
                  <span className="text-slate-400">{f.label}</span>
                  <span className="font-mono">{f.value}{f.unit ? ` ${f.unit}` : ''}{f.sampleSize !== null ? <span className="ml-1 text-[10px] text-slate-500">n={f.sampleSize}</span> : null}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-[10px] uppercase tracking-widest text-slate-500">Not available ({missing.length})</h4>
            <ul className="mt-1 space-y-1 text-sm text-slate-500">
              {missing.map((f) => <li key={f.key}>{f.label}</li>)}
            </ul>
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Round 2 — Skeptic</h3>
        {two.objections.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No objection was raised.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {two.objections.map((o, i) => {
              const response = two.responses.find((r) => r.code === o.code);
              return (
                <li key={`${o.code}-${i}`} className={`rounded-lg border px-3 py-2 text-sm ${SEVERITY_STYLE[o.severity]}`}>
                  <p>
                    <span className="font-mono text-xs font-semibold">{o.severity}</span> <span className="font-mono text-xs">{o.code}</span> → {o.targetAgent}
                  </p>
                  <p className="mt-1">{o.summary}</p>
                  {response && (
                    <p className="mt-1 text-xs opacity-80">
                      <span className="font-semibold">{response.agent} responds:</span> {response.response} {response.conceded ? '(objection stands)' : '(rebutted with data)'}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {four.notes.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Round 4 — Bookkeeper</h3>
          <ul className="mt-2 space-y-1 text-xs text-amber-300">
            {four.notes.map((n, i) => <li key={i}>• {n}</li>)}
          </ul>
        </section>
      )}

      <p className="text-xs text-slate-600">
        Model {transcript.modelVersion} · knowledge cutoff {fmtDate(transcript.asOf)} · {transcript.dataEnvironment}
      </p>
    </div>
  );
}

export function DebatePanel({ matchId }: { matchId: string }) {
  const stored = useApi(() => api.debate(matchId), [matchId]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);

  const run = async () => {
    setRunning(true);
    setRunError(null);
    setNeedsToken(false);
    try {
      await api.runDebate(matchId);
      stored.reload();
    } catch (e: unknown) {
      // A refusal is a missing token, not a failure worth a red error box.
      if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
      else setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card title="Four-agent debate" subtitle="Scout, Copycat, Skeptic and Bookkeeper. A veto forces no pick.">
      <div className="mb-4">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {running ? 'Debating…' : stored.data?.status === 'DEBATED' ? 'Run the debate again' : 'Run the debate'}
        </button>
      </div>
      {needsToken && <TokenPrompt onSaved={() => { setNeedsToken(false); void run(); }} />}
      {runError && <ErrorBox message={runError} />}
      {stored.loading ? (
        <Loading />
      ) : stored.error ? (
        <ErrorBox message={stored.error} />
      ) : stored.data?.status !== 'DEBATED' || !stored.data.transcript ? (
        <p className="text-sm text-slate-500">This match has not been debated yet.</p>
      ) : (
        <Transcript transcript={stored.data.transcript} />
      )}
    </Card>
  );
}
