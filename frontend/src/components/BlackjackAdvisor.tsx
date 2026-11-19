import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError, api,
  type BlackjackAction, type BlackjackDecision, type BlackjackRules,
  type RecordedDecision, type StandOutcomes,
} from '../services/api';
import { ErrorBox } from './ui';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const card = (rank: number): string => RANKS[rank] ?? '?';
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 4): string => (v >= 0 ? '+' : '') + v.toFixed(d);

/** Display only: every figure the advice rests on is solved on the server. */
function handTotal(cards: readonly number[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c === 0) { aces += 1; total += 11; } else total += Math.min(c + 1, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return { total, soft: aces > 0 };
}

export type Reported = 'win' | 'lose' | 'push';

export interface PlayedHand {
  id: number;
  playerCards: number[];
  dealerUpcard: number;
  playerFinal: number[];
  dealerFinal: number[];
  reported: Reported;
  computed: Reported | null;
  decisions: RecordedDecision[];
  openingForecast: StandOutcomes | null;
  recorded: 'yes' | 'unauthorised' | 'failed' | 'not-sent';
}

const ACTION_LABEL: Record<BlackjackAction, string> = {
  Hit: 'Hit', Stand: 'Stand', Double: 'Double', Split: 'Split', Surrender: 'Surrender',
};

/** How many of each rank a shoe of this size holds. Tens are four ranks in one. */
const supply = (decks: number, rank: number): number => decks * (rank === 9 ? 16 : 4);

function RankPicker({
  label, onPick, remaining, disabled = false,
}: { label: string; onPick: (rank: number) => void; remaining: number[]; disabled?: boolean }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {RANKS.map((r, i) => {
          const left = remaining[i];
          return (
            <button
              key={r}
              type="button"
              disabled={disabled || left <= 0}
              onClick={() => onPick(i)}
              // The rank and the count sit in adjacent spans, which read as one run-on word.
              aria-label={`${r === 'A' ? 'ace' : r}, ${left} left in the shoe`}
              title={`${left} left in the shoe`}
              className="relative rounded-md border border-slate-700 px-3 py-1.5 font-mono text-sm text-slate-200 hover:border-emerald-500 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {r}
              <span className="ml-1 text-[9px] text-slate-500">{left}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Chips({ cards, onRemove }: { cards: number[]; onRemove?: (index: number) => void }) {
  if (cards.length === 0) return <span className="text-xs text-slate-600">none yet</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {cards.map((c, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onRemove?.(i)}
          disabled={!onRemove}
          title={onRemove ? 'Remove this card' : undefined}
          className="inline-flex h-11 w-8 items-center justify-center rounded-md border-2 border-slate-300 bg-gradient-to-br from-white to-slate-200 font-mono text-base font-bold text-slate-900 enabled:hover:border-rose-400"
        >
          {card(c)}
        </button>
      ))}
    </span>
  );
}

export function BlackjackAdvisor({
  rules, onHandRecorded,
}: { rules: BlackjackRules; onHandRecorded: (hand: PlayedHand) => void }) {
  // Cards gone from the shoe in earlier hands, so the count and the odds are the real ones.
  const [seen, setSeen] = useState<number[]>([]);
  const [player, setPlayer] = useState<number[]>([]);
  const [upcard, setUpcard] = useState<number | null>(null);
  const [dealerFinal, setDealerFinal] = useState<number[]>([]);
  const [doubled, setDoubled] = useState(false);
  const [trail, setTrail] = useState<RecordedDecision[]>([]);
  const [analysis, setAnalysis] = useState<(BlackjackDecision & { standOutcomes: StandOutcomes }) | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [handId, setHandId] = useState(1);

  // Nothing may be picked that the shoe no longer holds.
  const remaining = useMemo(() => {
    const used = [...seen, ...player, ...(upcard === null ? [] : [upcard]), ...dealerFinal];
    return RANKS.map((_, rank) => Math.max(0, supply(rules.decks, rank) - used.filter((c) => c === rank).length));
  }, [seen, player, upcard, dealerFinal, rules.decks]);

  const ready = player.length >= 2 && upcard !== null;

  const refresh = useCallback(async () => {
    if (!ready || finishing) { setAnalysis(null); return; }
    setBusy(true);
    setError(null);
    try {
      setAnalysis(await api.blackjackEvaluate({ hand: player, upcard: upcard!, seen, rules }));
    } catch (e) {
      setAnalysis(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [ready, finishing, player, upcard, seen, rules]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Records what the solver said at this point, so the advice can be judged later. */
  const remember = (chosen: BlackjackAction): void => {
    if (!analysis) return;
    const { total, soft } = handTotal(player);
    setTrail((t) => [...t, {
      cards: [...player],
      total,
      soft,
      available: analysis.actions.map((a) => a.action),
      actionEvs: analysis.actions.map((a) => ({ action: a.action, ev: a.ev })),
      recommended: analysis.best.action,
      chosen,
      standOutcomes: analysis.standOutcomes,
      unseenCards: analysis.unseenCards,
    }]);
  };

  const computed: Reported | null = useMemo(() => {
    if (dealerFinal.length < 2 || player.length < 2) return null;
    const me = handTotal(player).total;
    const them = handTotal(dealerFinal).total;
    if (me > 21) return 'lose';
    if (them > 21 || me > them) return 'win';
    if (me < them) return 'lose';
    return 'push';
  }, [player, dealerFinal]);

  const reset = (): void => {
    setPlayer([]);
    setUpcard(null);
    setDealerFinal([]);
    setDoubled(false);
    setTrail([]);
    setAnalysis(null);
    setFinishing(false);
    setError(null);
  };

  const report = async (reported: Reported): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const opening = player.slice(0, 2);
    let recorded: PlayedHand['recorded'] = 'not-sent';
    if (dealerFinal.length >= 2) {
      try {
        await api.recordObservation({
          rules,
          seen,
          playerCards: opening,
          dealerUpcard: upcard!,
          dealerFinalCards: dealerFinal,
          playerFinalCards: player,
          stake: doubled ? 2 : 1,
          surrendered: false,
          decisions: trail,
        });
        recorded = 'yes';
      } catch (e) {
        recorded = e instanceof ApiError && e.status === 401 ? 'unauthorised' : 'failed';
        if (!(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : String(e));
      }
    }

    onHandRecorded({
      id: handId,
      playerCards: opening,
      dealerUpcard: upcard!,
      playerFinal: [...player],
      dealerFinal: [...dealerFinal],
      reported,
      computed,
      decisions: trail,
      openingForecast: trail[0]?.standOutcomes ?? null,
      recorded,
    });

    setSeen((s) => [...s, ...player, ...(dealerFinal.length >= 2 ? dealerFinal : [upcard!])]);
    setHandId((n) => n + 1);
    setNote(
      dealerFinal.length < 2
        ? 'Result kept for this session. Add the dealer’s final cards next time and the hand also joins the observation record, which is what the model is judged against.'
        : recorded === 'unauthorised'
          ? 'Result kept for this session. Adding it to the observation record needs the deployment token.'
          : null,
    );
    reset();
    setBusy(false);
  };

  const dealerTotal = dealerFinal.length ? handTotal(dealerFinal).total : null;
  const mine = handTotal(player);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
      <section className="rounded-xl border border-emerald-900/50 bg-[radial-gradient(ellipse_at_top,_rgba(5,150,105,0.14),_transparent_60%)] bg-slate-900/70 p-4" aria-label="Enter the hand">
        <div className="space-y-5">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Dealer shows {upcard !== null && <span className="ml-1 font-mono text-sm text-slate-200">{card(upcard)}</span>}
              </p>
              {upcard !== null && !finishing && (
                <button type="button" onClick={() => setUpcard(null)} className="text-[11px] text-slate-500 hover:text-rose-300">change</button>
              )}
            </div>
            {upcard === null
              ? <div className="mt-1.5"><RankPicker label="" onPick={setUpcard} remaining={remaining} /></div>
              : <div className="mt-1.5"><Chips cards={[upcard]} /></div>}
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Your hand {player.length > 0 && <span className="ml-1 font-mono text-sm text-slate-200">{mine.total}{mine.soft ? ' soft' : ''}</span>}
                {doubled && <span className="ml-2 rounded bg-slate-700/70 px-1.5 py-0.5 text-[10px] text-slate-300">doubled</span>}
              </p>
            </div>
            <div className="mt-1.5"><Chips cards={player} onRemove={finishing ? undefined : (i) => setPlayer((p) => p.filter((_, j) => j !== i))} /></div>
            {!finishing && <div className="mt-2"><RankPicker label={player.length < 2 ? 'Pick your two cards' : 'Add a card you drew'} onPick={(r) => setPlayer((p) => [...p, r])} remaining={remaining} /></div>}
          </div>

          {error && <ErrorBox message={error} />}

          {!finishing ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!ready || busy}
                onClick={() => { remember('Double'); setDoubled(true); }}
                className="rounded-md bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-40"
              >
                I doubled
              </button>
              <button
                type="button"
                disabled={!ready || busy}
                onClick={() => { remember('Stand'); setFinishing(true); }}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                Hand finished →
              </button>
              {player.length > 0 && (
                <button type="button" onClick={reset} className="ml-auto text-[11px] text-slate-500 hover:text-rose-300">clear</button>
              )}
            </div>
          ) : (
            <div className="space-y-4 rounded-lg border border-sky-500/40 bg-sky-500/10 p-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-sky-200">
                  Dealer finished {dealerTotal !== null && <span className="ml-1 font-mono text-sm">{dealerTotal}{dealerTotal > 21 ? ' bust' : ''}</span>}
                </p>
                <p className="mt-0.5 text-[11px] text-sky-200/70">
                  Their upcard is already counted. Add the rest of their hand — without it the result is kept for this
                  session but cannot join the observation record, which scores the dealer forecast.
                </p>
                <div className="mt-1.5"><Chips cards={dealerFinal} onRemove={(i) => setDealerFinal((d) => d.filter((_, j) => j !== i))} /></div>
                <div className="mt-2">
                  <RankPicker
                    label=""
                    onPick={(r) => setDealerFinal((d) => (d.length === 0 ? [upcard!, r] : [...d, r]))}
                    remaining={remaining}
                  />
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-sky-200">How did it go?</p>
                {computed && (
                  <p className="mt-0.5 text-[11px] text-sky-200/70">From the cards entered this is a {computed}. Your answer is what gets recorded.</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['win', 'lose', 'push'] as const).map((o) => (
                    <button
                      key={o}
                      type="button"
                      disabled={busy}
                      onClick={() => void report(o)}
                      className="rounded-md bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-50"
                    >
                      {o === 'win' ? 'I won' : o === 'lose' ? 'I lost' : 'Push'}
                    </button>
                  ))}
                  <button type="button" onClick={() => setFinishing(false)} className="ml-auto text-[11px] text-slate-500 hover:text-slate-300">back</button>
                </div>
              </div>
            </div>
          )}

          {note && <p className="text-[11px] text-amber-300">{note}</p>}

          <div className="flex items-center justify-between border-t border-slate-800 pt-3 text-[11px] text-slate-500">
            <span>Hand #{handId} · {seen.length} cards gone from the shoe</span>
            {seen.length > 0 && (
              <button type="button" onClick={() => { setSeen([]); setNote('Shoe reset.'); }} className="hover:text-sky-300">new shoe</button>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4" aria-label="Advice" aria-live="polite">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">What to do</h3>
        {!ready ? (
          <p className="mt-3 text-sm text-slate-500">
            Pick the dealer&apos;s upcard and your two cards. Everything here is then solved from the cards still in the
            shoe — not looked up in a chart.
          </p>
        ) : finishing ? (
          <p className="mt-3 text-sm text-slate-500">Enter how the hand ended, and it is kept with the advice that preceded it.</p>
        ) : !analysis ? (
          <p className="mt-3 text-sm text-slate-500">{busy ? 'Solving…' : 'No answer yet.'}</p>
        ) : (
          <div className="mt-3 space-y-4">
            <div className="rounded-lg bg-emerald-500/10 p-3 text-center">
              <p className="text-[10px] uppercase tracking-widest text-emerald-300/70">Play</p>
              <p className="font-mono text-3xl font-black text-emerald-300">{ACTION_LABEL[analysis.best.action].toUpperCase()}</p>
              <p className="mt-1 text-[11px] text-emerald-200/70">
                on {analysis.total}{analysis.soft ? ' soft' : ''} against {card(upcard!)}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              {([['Win', analysis.standOutcomes.win, 'text-emerald-300'], ['Push', analysis.standOutcomes.push, 'text-slate-300'], ['Lose', analysis.standOutcomes.lose, 'text-rose-300']] as const).map(([label, value, tone]) => (
                <div key={label} className="rounded-lg bg-slate-950/60 p-2">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
                  <p className={`font-mono text-lg ${tone}`}>{pct(value)}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">If you stand here.</p>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Expected value per action</p>
              <ul className="mt-1.5 space-y-1">
                {analysis.actions.map((a) => (
                  <li key={a.action} className={`flex items-center justify-between rounded-md px-2 py-1 text-sm ${a.action === analysis.best.action ? 'bg-emerald-500/10 text-emerald-200' : 'text-slate-300'}`}>
                    <span>{ACTION_LABEL[a.action]}</span>
                    <span className="font-mono">{signed(a.ev)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1 text-[11px] text-slate-400">
              <p className="font-semibold uppercase tracking-widest text-slate-400">Why</p>
              <p>
                The dealer busts {pct(analysis.dealerDistribution[5])} of the time from {card(upcard!)}, and reaches 17–21
                otherwise. Enumerated over the {analysis.unseenCards} cards you have not accounted for.
              </p>
              <p>
                {analysis.margin === null || analysis.margin > 0.05
                  ? `${ACTION_LABEL[analysis.best.action]} is clearly best.`
                  : `${ACTION_LABEL[analysis.best.action]} is best by only ${analysis.margin.toFixed(4)} — the choice barely matters here.`}
              </p>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Dealer final total</p>
              <div className="mt-1 space-y-1">
                {['17', '18', '19', '20', '21', 'bust'].map((label, i) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="w-8 font-mono text-[11px] text-slate-500">{label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${Math.min(100, analysis.dealerDistribution[i] * 240)}%` }} />
                    </span>
                    <span className="w-12 text-right font-mono text-[11px] text-slate-400">{pct(analysis.dealerDistribution[i])}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
