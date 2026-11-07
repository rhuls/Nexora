import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, ErrorBox, Loading, Unavailable, pct } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, type BlackjackAction, type BlackjackDecision, type BlackjackRules, type BlackjackSimulation } from '../services/api';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const DEFAULT_RULES: BlackjackRules = { decks: 6, hitSoft17: false, doubleAnyTwo: true, das: true, surrender: false, blackjackPays: 1.5, peek: true };

const ACTION_STYLE: Record<string, string> = {
  H: 'bg-rose-500/15 text-rose-300',
  S: 'bg-emerald-500/15 text-emerald-300',
  D: 'bg-amber-500/15 text-amber-300',
  P: 'bg-slate-700/60 text-slate-200',
  R: 'bg-sky-500/15 text-sky-300',
};

const fmt = (v: number, d = 4) => (v >= 0 ? '+' : '') + v.toFixed(d);

/* A hand is edited by rank, so any situation can be posed without dealing to it. */
function HandEditor({ label, cards, onChange, max }: { label: string; cards: number[]; onChange: (c: number[]) => void; max: number }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {RANKS.map((r, i) => (
          <button
            key={r}
            type="button"
            disabled={cards.length >= max}
            onClick={() => onChange([...cards, i])}
            className="rounded-md border border-slate-700 px-2.5 py-1 font-mono text-sm text-slate-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-40"
          >
            {r}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {cards.length === 0 ? (
          <span className="text-xs text-slate-500">No cards yet</span>
        ) : (
          cards.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onChange(cards.filter((_, k) => k !== i))}
              title="Remove"
              className="rounded-md bg-slate-100 px-2.5 py-1 font-mono text-sm font-bold text-slate-900 hover:bg-rose-200"
            >
              {RANKS[c]}
            </button>
          ))
        )}
        {cards.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="ml-1 text-xs text-slate-500 underline hover:text-slate-300">
            clear
          </button>
        )}
      </div>
    </div>
  );
}

function DecisionPanel({ decision }: { decision: BlackjackDecision }) {
  const max = Math.max(0.2, ...decision.actions.map((a) => Math.abs(a.ev)));
  const close = decision.margin !== null && decision.margin < 0.02;
  return (
    <>
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <p className="font-mono text-xs uppercase tracking-widest text-slate-500">
          {decision.soft ? 'Soft' : 'Hard'} {decision.total} · {decision.unseenCards} cards unseen
        </p>
        <p className="mt-1 text-3xl font-black tracking-tight text-emerald-300">{decision.best.action}</p>
        <p className="mt-1 text-sm text-slate-400">
          Expected value {fmt(decision.best.ev)} units
          {decision.actions.length > 1 && <> , against {fmt(decision.actions[1].ev)} for {decision.actions[1].action.toLowerCase()}</>}
        </p>
        {close && (
          <p className="mt-2 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            margin {decision.margin!.toFixed(4)} — close either way
          </p>
        )}
      </div>
      <div className="mt-4 space-y-1">
        {decision.actions.map((a) => {
          const w = (Math.abs(a.ev) / max) * 50;
          const left = a.ev >= 0 ? 50 : 50 - w;
          return (
            <div key={a.action} className="grid grid-cols-[76px_1fr_72px] items-center gap-3 py-1">
              <span className={`text-sm font-bold ${a.action === decision.best.action ? 'text-emerald-300' : 'text-slate-300'}`}>{a.action}</span>
              <span className="relative h-2 overflow-hidden rounded-full bg-slate-800">
                <span className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
                <span className={`absolute inset-y-0 rounded-full ${a.ev >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ left: `${left}%`, width: `${w}%` }} />
              </span>
              <span className={`text-right font-mono text-xs tabular-nums ${a.ev >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmt(a.ev)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Dealer finishes</p>
        <table className="mt-1 w-full text-xs">
          <thead className="text-slate-500">
            <tr>{['17', '18', '19', '20', '21', 'bust'].map((h) => <th key={h} scope="col" className="font-mono font-normal">{h}</th>)}</tr>
          </thead>
          <tbody>
            <tr className="text-center font-mono tabular-nums text-slate-300">
              {decision.dealerDistribution.map((p, i) => (
                <td key={i} className={i === 5 ? 'text-rose-400' : ''}>{(p * 100).toFixed(1)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

export function BlackjackPage() {
  const [rules, setRules] = useState<BlackjackRules>(DEFAULT_RULES);
  const [hand, setHand] = useState<number[]>([9, 5]);
  const [upcard, setUpcard] = useState(9);
  const [seen, setSeen] = useState<number[]>([]);
  const [decision, setDecision] = useState<BlackjackDecision | null>(null);
  const [decError, setDecError] = useState<string | null>(null);
  const [sim, setSim] = useState<BlackjackSimulation | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [rounds, setRounds] = useState(100000);

  const chart = useApi(() => api.blackjackStrategy(rules), [rules]);
  const edge = useApi(() => api.blackjackEdge(rules), [rules]);

  const solve = useCallback(async () => {
    if (hand.length < 2) { setDecision(null); setDecError(null); return; }
    try {
      setDecError(null);
      setDecision(await api.blackjackEvaluate({ hand, upcard, seen, rules }));
    } catch (e: unknown) {
      setDecision(null);
      setDecError(e instanceof Error ? e.message : String(e));
    }
  }, [hand, upcard, seen, rules]);

  useEffect(() => { void solve(); }, [solve]);

  const runSim = async () => {
    setSimBusy(true);
    try { setSim(await api.blackjackSimulate({ rounds, seed: 1, rules })); }
    catch (e: unknown) { setDecError(e instanceof Error ? e.message : String(e)); }
    finally { setSimBusy(false); }
  };

  const set = <K extends keyof BlackjackRules>(k: K, v: BlackjackRules[K]) => setRules((r) => ({ ...r, [k]: v }));
  const upLabel = useMemo(() => (chart.data ? chart.data.upcards : [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]), [chart.data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Blackjack</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          A second domain for the same discipline: compute exactly, verify against a known baseline, and say what was approximated.
          Every value here is solved from the cards not yet seen — nothing is read from a stored chart. No stakes, no money.
        </p>
      </div>

      <Card title="Rules" subtitle="Changing a rule re-derives the chart and the edge rather than invalidating them">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500">
            Decks
            <select value={rules.decks} onChange={(e) => set('decks', Number(e.target.value))} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200">
              {[1, 2, 4, 6, 8].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500">
            Dealer soft 17
            <select value={rules.hitSoft17 ? '1' : '0'} onChange={(e) => set('hitSoft17', e.target.value === '1')} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200">
              <option value="0">Stands</option><option value="1">Hits</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500">
            Blackjack pays
            <select value={rules.blackjackPays} onChange={(e) => set('blackjackPays', Number(e.target.value))} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200">
              <option value={1.5}>3 : 2</option><option value={1.2}>6 : 5</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={rules.das} onChange={(e) => set('das', e.target.checked)} className="h-4 w-4 accent-emerald-500" /> Double after split
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={rules.surrender} onChange={(e) => set('surrender', e.target.checked)} className="h-4 w-4 accent-emerald-500" /> Late surrender
          </label>
        </div>
        <div className="mt-4 border-t border-slate-800 pt-3">
          {edge.loading ? <Loading /> : edge.error ? <ErrorBox message={edge.error} /> : edge.data && (
            <p className="text-sm text-slate-300">
              Under optimal play the player expects{' '}
              <strong className={`font-mono ${edge.data.playerEV >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{(edge.data.playerEV * 100).toFixed(3)}%</strong>{' '}
              per unit staked — the house keeps <strong className="font-mono">{(edge.data.houseEdge * 100).toFixed(3)}%</strong>.
              <span className={`ml-2 text-xs ${edge.data.reliability === 'GOOD' ? 'text-slate-500' : 'text-amber-300'}`}>{edge.data.note}</span>
            </p>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pose a hand" subtitle="Add cards by rank; removed cards leave the shoe">
          <div className="space-y-4">
            <HandEditor label="Your hand" cards={hand} onChange={setHand} max={12} />
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Dealer shows</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {RANKS.map((r, i) => (
                  <button key={r} type="button" onClick={() => setUpcard(i)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-sm ${upcard === i ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <HandEditor label="Other cards already seen (optional)" cards={seen} onChange={setSeen} max={200} />
          </div>
        </Card>

        <Card title="Solver">
          {decError ? <ErrorBox message={decError} />
            : hand.length < 2 ? <p className="text-sm text-slate-500">Add at least two cards to your hand.</p>
            : decision ? <DecisionPanel decision={decision} />
            : <Loading />}
        </Card>
      </div>

      <Card title="Strategy, derived" subtitle={chart.data ? `${chart.data.cells} cells solved for these rules` : 'Solving…'}>
        {chart.loading ? <Loading /> : chart.error ? <ErrorBox message={chart.error} /> : chart.data && (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-[470px] border-separate border-spacing-[2px] font-mono text-[11px]">
                <thead>
                  <tr>
                    <th />
                    {upLabel.map((u) => <th key={u} scope="col" className="w-[30px] text-center font-semibold text-slate-400">{RANKS[u]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {chart.data.rows.map((row) => (
                    <tr key={`${row.kind}-${row.label}`}>
                      <th scope="row" className="whitespace-nowrap pr-2 text-right font-semibold text-slate-400">{row.label}</th>
                      {row.cells.map((c) => (
                        <td key={c.upcard} title={`${row.label} vs ${RANKS[c.upcard]}: ${c.action} (EV ${fmt(c.ev)})`}
                          className={`h-6 w-[30px] rounded text-center font-semibold ${ACTION_STYLE[c.code] ?? ''}`}>
                          {c.code}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap gap-4 font-mono text-[11px] text-slate-400">
              {[['H', 'Hit'], ['S', 'Stand'], ['D', 'Double'], ['P', 'Split'], ['R', 'Surrender']].map(([c, n]) => (
                <span key={c}><i className={`mr-1.5 inline-block h-3 w-3 rounded align-[-1px] ${ACTION_STYLE[c]}`} />{n}</span>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card title="Simulation" subtitle="Seeded, so the same run always returns the same figures">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500">
            Rounds
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200">
              {[10000, 100000, 500000, 1000000].map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void runSim()} disabled={simBusy}
            className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
            {simBusy ? 'Dealing…' : 'Deal'}
          </button>
        </div>
        {sim && (
          <div className="mt-4 space-y-4">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                ['Dealt', sim.evPerRound, (v: number) => `${(v * 100).toFixed(3)}%`],
                ['Computed', sim.computedEV, (v: number) => `${(v * 100).toFixed(3)}%`],
              ].map(([label, v, f]) => (
                <div key={label as string}>
                  <dt className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{label as string}</dt>
                  <dd className="mt-1 font-mono text-lg tabular-nums">{(f as (n: number) => string)(v as number)}</dd>
                </div>
              ))}
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-widest text-slate-500">95% interval</dt>
                <dd className="mt-1 font-mono text-sm tabular-nums">{(sim.interval95[0] * 100).toFixed(3)}% to {(sim.interval95[1] * 100).toFixed(3)}%</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Won / lost / push</dt>
                <dd className="mt-1 font-mono text-sm tabular-nums">{pct(sim.winRate)} / {pct(sim.lossRate)} / {pct(sim.pushRate)}</dd>
              </div>
            </dl>
            <p className={`rounded-lg border px-3 py-2 text-sm ${sim.agrees ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}>
              {sim.agrees
                ? 'The enumerated figure falls inside the dealt interval. Two independent routes to the same number agree.'
                : 'The enumerated figure falls outside this interval — at this sample size that happens about one run in twenty, so repeat it with another seed before concluding anything.'}
            </p>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Winning runs, against independent trials</p>
              <table className="mt-1 w-full text-xs">
                <thead className="text-slate-500"><tr><th scope="col" className="text-left font-normal">Run</th><th scope="col" className="text-right font-normal">Observed</th><th scope="col" className="text-right font-normal">If independent</th><th scope="col" className="text-right font-normal">Ratio</th></tr></thead>
                <tbody>
                  {sim.streaks.map((s) => (
                    <tr key={s.length} className="border-t border-slate-800 font-mono tabular-nums">
                      <td className="py-1">{s.length}+</td>
                      <td className="text-right">{(s.observed * 100).toFixed(3)}%</td>
                      <td className="text-right">{(s.independent * 100).toFixed(3)}%</td>
                      <td className="text-right text-slate-400">{s.ratio.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                Runs come out a few percent above the independent prediction because a split puts two hands behind one dealer hand; when the dealer busts they win together.
              </p>
            </div>
          </div>
        )}
        {!sim && !simBusy && <p className="mt-3 text-sm text-slate-500">Not run yet.</p>}
      </Card>

      <Card title="What is approximate">
        <ul className="space-y-1.5 pl-4 text-sm text-slate-400">
          <li className="list-disc">The dealer's distribution is enumerated without replacement from the real remaining cards; branches below 1e-11 are dropped.</li>
          <li className="list-disc">Your own draws use the composition fixed at the moment you decide, which costs about 0.01%.</li>
          <li className="list-disc">A split makes exactly two hands and never resplits, in both the solver and the simulator, so the two stay comparable. Real resplitting is worth roughly 0.05% to the player.</li>
          <li className="list-disc">Insurance is not offered: it is a side bet on the hole card, not a decision about your hand.</li>
          <li className="list-disc">Single deck is the weak spot — taking three known cards out of 52 disturbs the deck far more than taking them out of 312. Trust the six- and eight-deck figures.</li>
        </ul>
      </Card>
    </div>
  );
}
