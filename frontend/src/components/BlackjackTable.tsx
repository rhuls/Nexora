import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError, api,
  type BlackjackAction, type BlackjackDecision, type BlackjackRules,
  type RecordedDecision, type StandOutcomes,
} from '../services/api';
import { ErrorBox } from './ui';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const card = (rank: number): string => RANKS[rank] ?? '?';
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 3): string => (v >= 0 ? '+' : '') + v.toFixed(d);

/** Display only. Every figure the game is judged on comes from the solver, never from here. */
function handTotal(cards: readonly number[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c === 0) { aces += 1; total += 11; } else total += Math.min(c + 1, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return { total, soft: aces > 0 };
}

interface Hand {
  cards: number[];
  stake: number;
  fromSplit: boolean;
  surrendered: boolean;
  done: boolean;
}

type Phase = 'idle' | 'playing' | 'settled';

export interface CompletedHand {
  id: number;
  dealtAt: string;
  playerCards: number[];
  dealerUpcard: number;
  hands: Array<{ cards: number[]; outcome: string; net: number }>;
  dealerFinal: number[];
  net: number;
  openingForecast: StandOutcomes | null;
  openingRecommendation: BlackjackAction | null;
  decisions: RecordedDecision[];
  recorded: 'yes' | 'unauthorised' | 'failed' | 'settled-on-deal';
  modelVersion: string;
}

const ACTION_LABEL: Record<BlackjackAction, string> = {
  Hit: 'Hit', Stand: 'Stand', Double: 'Double', Split: 'Split', Surrender: 'Surrender',
};

// Double takes B and Split takes P because D deals and S stands. The badge is rendered from this
// map rather than from the action's first letter, which had Split claiming S as well.
const SHORTCUT: Record<BlackjackAction, string> = {
  Hit: 'h', Stand: 's', Double: 'b', Split: 'p', Surrender: 'r',
};

function PlayingCard({ rank, hidden = false, index }: { rank: number; hidden?: boolean; index: number }) {
  return (
    <span
      className={`inline-flex h-16 w-12 animate-[deal_220ms_ease-out] items-center justify-center rounded-lg border-2 font-mono text-lg font-bold shadow-lg ${
        hidden ? 'border-slate-600 bg-gradient-to-br from-slate-700 to-slate-800 text-slate-500' : 'border-slate-300 bg-gradient-to-br from-white to-slate-200 text-slate-900'
      }`}
      style={{ animationDelay: `${index * 70}ms`, animationFillMode: 'backwards' }}
      aria-hidden={hidden}
    >
      {hidden ? '' : card(rank)}
    </span>
  );
}

function Seat({ label, cards, total, hideSecond, badge }: { label: string; cards: number[]; total?: string; hideSecond?: boolean; badge?: string }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
        {total && <p className="font-mono text-sm text-slate-200">{total}</p>}
        {badge && <span className="rounded bg-slate-700/70 px-1.5 py-0.5 text-[10px] text-slate-300">{badge}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {cards.length === 0
          ? <span className="text-xs text-slate-600">—</span>
          : cards.map((c, i) => <PlayingCard key={i} rank={c} index={i} hidden={hideSecond && i === 1} />)}
      </div>
    </div>
  );
}

export function BlackjackTable({
  rules, onHandComplete,
}: { rules: BlackjackRules; onHandComplete: (hand: CompletedHand) => void }) {
  const [seen, setSeen] = useState<number[]>([]);
  const [seenBeforeHand, setSeenBeforeHand] = useState<number[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [hands, setHands] = useState<Hand[]>([]);
  const [active, setActive] = useState(0);
  const [dealer, setDealer] = useState<{ upcard: number; hole: number; final: number[] } | null>(null);
  const [analysis, setAnalysis] = useState<(BlackjackDecision & { standOutcomes: StandOutcomes }) | null>(null);
  const [trail, setTrail] = useState<RecordedDecision[]>([]);
  const [outcome, setOutcome] = useState<{ hands: Array<{ cards: number[]; outcome: string; net: number }>; net: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<{ running: number; true: number }>({ running: 0, true: 0 });
  const [reshuffled, setReshuffled] = useState(false);
  // The two cards this hand was dealt. Kept because a split replaces them and the observation is
  // filed against what was actually dealt.
  const [opening, setOpening] = useState<number[]>([]);
  const handId = useRef(0);

  const activeHand = hands[active];
  // Kept so the panel can say what was forecast once the hand is over, instead of going blank.
  const lastForecast = trail[0]?.standOutcomes ?? null;

  const analyse = useCallback(async (cards: number[], upcard: number, seenNow: number[], fromSplit: boolean) => {
    const decision = await api.blackjackEvaluate({ hand: cards, upcard, seen: seenNow, afterSplit: fromSplit, rules });
    setAnalysis(decision);
    return decision;
  }, [rules]);

  const settle = useCallback(async (finished: Hand[], d: { upcard: number; hole: number }, seenNow: number[], trailNow: RecordedDecision[], opening: number[]) => {
    const result = await api.trainerSettle({
      rules,
      seen: seenNow,
      dealer: [d.upcard, d.hole],
      hands: finished.map((h) => ({ cards: h.cards, stake: h.stake, surrendered: h.surrendered })),
    });
    setDealer({ upcard: d.upcard, hole: d.hole, final: result.dealer });
    setOutcome({ hands: result.hands, net: result.net });
    setSeen([...seenNow, d.hole, ...result.drawn]);
    setPhase('settled');

    // The game dealt these cards and played the dealer out, so it knows the result. Nothing is
    // asked of the player and nothing is taken on trust: the forecast is recomputed server-side
    // from the same inputs before it is stored.
    const split = finished.length > 1;
    const drawn = finished.reduce((sum, h) => sum + Math.max(0, h.cards.length - (h.fromSplit ? 1 : opening.length)), 0);
    // A hand that settled on the deal had no decision and never put the dealer forecast to the
    // test, so it is not an observation of it. Not an error, and not something to retry.
    let recorded: CompletedHand['recorded'] = 'settled-on-deal';
    if (trailNow.length > 0) {
    try {
      await api.recordObservation({
        rules,
        seen: seenBeforeHand,
        playerCards: opening,
        dealerUpcard: d.upcard,
        dealerFinalCards: result.dealer,
        playerFinalCards: finished[0].cards,
        stake: finished.reduce((sum, h) => sum + h.stake, 0),
        surrendered: finished.every((h) => h.surrendered),
        split,
        cardsDrawn: drawn,
        decisions: trailNow,
      });
      recorded = 'yes';
    } catch (e) {
      recorded = e instanceof ApiError && e.status === 401 ? 'unauthorised' : 'failed';
    }
    }

    handId.current += 1;
    onHandComplete({
      id: handId.current,
      dealtAt: new Date().toISOString(),
      playerCards: opening,
      dealerUpcard: d.upcard,
      hands: result.hands,
      dealerFinal: result.dealer,
      net: result.net,
      openingForecast: trailNow[0]?.standOutcomes ?? null,
      openingRecommendation: (trailNow[0]?.recommended as BlackjackAction) ?? null,
      decisions: trailNow,
      recorded,
      modelVersion: 'solver-1.0',
    });
  }, [rules, seenBeforeHand, onHandComplete]);

  const deal = useCallback(async () => {
    setBusy(true);
    setError(null);
    setAnalysis(null);
    setOutcome(null);
    setTrail([]);
    try {
      setSeenBeforeHand(seen);
      const d = await api.trainerDeal({ rules, seen, weak: [], drillBias: 0 });
      const nextSeen = d.reshuffled ? [...d.player, d.upcard] : [...seen, ...d.player, d.upcard];
      setReshuffled(d.reshuffled);
      if (d.reshuffled) setSeenBeforeHand([]);
      setSeen(nextSeen);
      setCount(d.count);
      setDealer({ upcard: d.upcard, hole: d.hole, final: [] });
      const dealt: Hand[] = [{ cards: d.player, stake: 1, fromSplit: false, surrendered: false, done: d.legalActions.length === 0 }];
      setOpening(d.player);
      setHands(dealt);
      setActive(0);

      if (d.legalActions.length === 0) {
        // A natural on either side ends the hand before anyone acts.
        setPhase('settled');
        await settle(dealt, d, nextSeen, [], d.player);
      } else {
        setPhase('playing');
        await analyse(d.player, d.upcard, nextSeen, false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  }, [rules, seen, analyse, settle]);

  const act = async (action: BlackjackAction) => {
    if (!dealer || !activeHand || busy || phase !== 'playing' || !analysis) return;
    setBusy(true);
    setError(null);
    try {
      const { total, soft } = handTotal(activeHand.cards);
      const step: RecordedDecision = {
        cards: [...activeHand.cards],
        total,
        soft,
        available: legalActions,
        actionEvs: analysis.actions.map((a) => ({ action: a.action, ev: a.ev })),
        recommended: analysis.best.action,
        chosen: action,
        standOutcomes: analysis.standOutcomes,
        unseenCards: analysis.unseenCards,
      };
      const trailNow = [...trail, step];
      setTrail(trailNow);

      let seenNow = [...seen];
      const next = hands.map((h) => ({ ...h, cards: [...h.cards] }));
      const hand = next[active];

      if (action === 'Stand') hand.done = true;
      else if (action === 'Surrender') { hand.surrendered = true; hand.done = true; }
      else if (action === 'Hit' || action === 'Double') {
        const { cards } = await api.trainerDraw({ rules, seen: seenNow, count: 1 });
        hand.cards.push(cards[0]);
        seenNow = [...seenNow, cards[0]];
        if (action === 'Double') { hand.stake = 2; hand.done = true; }
        if (handTotal(hand.cards).total >= 21) hand.done = true;
      } else if (action === 'Split') {
        const [rank] = hand.cards;
        const { cards } = await api.trainerDraw({ rules, seen: seenNow, count: 2 });
        seenNow = [...seenNow, ...cards];
        hand.cards = [rank, cards[0]];
        hand.fromSplit = true;
        const second: Hand = { cards: [rank, cards[1]], stake: 1, fromSplit: true, surrendered: false, done: false };
        // Split aces take one card each and stand, as at a table.
        if (rank === 0) { hand.done = true; second.done = true; }
        next.push(second);
      }

      setHands(next);
      setSeen(seenNow);
      const nextIndex = next.findIndex((h) => !h.done);
      setActive(nextIndex === -1 ? active : nextIndex);

      if (nextIndex === -1) {
        setAnalysis(null);
        await settle(next, dealer, seenNow, trailNow, opening);
      } else {
        await analyse(next[nextIndex].cards, dealer.upcard, seenNow, next[nextIndex].fromSplit);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const legalActions = useMemo((): BlackjackAction[] => {
    if (phase !== 'playing' || !activeHand) return [];
    const { total, soft } = handTotal(activeHand.cards);
    if (total >= 21) return [];
    const out: BlackjackAction[] = ['Hit', 'Stand'];
    const two = activeHand.cards.length === 2;
    if (two && (rules.doubleAnyTwo || (!soft && total >= 9 && total <= 11)) && (!activeHand.fromSplit || rules.das)) out.push('Double');
    if (two && activeHand.cards[0] === activeHand.cards[1] && !activeHand.fromSplit && hands.length < 2) out.push('Split');
    if (rules.surrender && two && !activeHand.fromSplit) out.push('Surrender');
    return out;
  }, [phase, activeHand, hands.length, rules]);

  useEffect(() => {
    // Keyboard shortcuts, because a table is played quickly.
    const onKey = (e: KeyboardEvent): void => {
      if (busy) return;
      const key = e.key.toLowerCase();
      if (key === 'd' && phase !== 'playing') void deal();
      if (phase !== 'playing') return;
      const action = (Object.keys(SHORTCUT) as BlackjackAction[]).find((a) => SHORTCUT[a] === key);
      if (action && legalActions.includes(action)) void act(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const dealerCards = dealer ? (phase === 'settled' && dealer.final.length > 0 ? dealer.final : [dealer.upcard, dealer.hole]) : [];
  const dealerTotal = phase === 'settled' && dealer ? String(handTotal(dealer.final).total) : dealer ? `${handTotal([dealer.upcard]).total} showing` : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
      <style>{`@keyframes deal { from { opacity: 0; transform: translateY(-14px) rotate(-4deg) } to { opacity: 1; transform: none } }`}</style>

      {/* The table */}
      <section
        className="rounded-xl border border-emerald-900/50 bg-[radial-gradient(ellipse_at_top,_rgba(5,150,105,0.16),_transparent_60%)] bg-slate-900/70 p-4"
        aria-label="Blackjack table"
      >
        <div className="flex min-h-[22rem] flex-col justify-between gap-5">
          <Seat
            label="Dealer"
            cards={dealerCards}
            total={dealerTotal}
            hideSecond={phase !== 'settled'}
            badge={phase === 'settled' && dealer && handTotal(dealer.final).total > 21 ? 'bust' : undefined}
          />

          <div className="space-y-3">
            {hands.map((h, i) => {
              const t = handTotal(h.cards);
              return (
                <div key={i} className={`rounded-lg p-2 transition ${i === active && phase === 'playing' ? 'bg-emerald-500/10 ring-1 ring-emerald-500/40' : ''}`}>
                  <Seat
                    label={hands.length > 1 ? `You · hand ${i + 1}` : 'You'}
                    cards={h.cards}
                    total={h.cards.length ? `${t.total}${t.soft ? ' soft' : ''}` : undefined}
                    badge={h.surrendered ? 'surrendered' : h.stake > 1 ? 'doubled' : t.total > 21 ? 'bust' : undefined}
                  />
                </div>
              );
            })}
            {hands.length === 0 && <Seat label="You" cards={[]} />}
          </div>

          {error && <ErrorBox message={error} />}

          {outcome && (
            <div
              className={`rounded-lg border p-3 ${outcome.net > 0 ? 'border-emerald-500/40 bg-emerald-500/10' : outcome.net < 0 ? 'border-rose-500/40 bg-rose-500/10' : 'border-slate-700 bg-slate-900/60'}`}
              aria-live="polite"
            >
              <p className={`text-sm font-semibold ${outcome.net > 0 ? 'text-emerald-200' : outcome.net < 0 ? 'text-rose-200' : 'text-slate-200'}`}>
                {outcome.hands.map((h) => h.outcome).join(', ')} · {signed(outcome.net, 2)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">Recorded automatically, with the forecast that preceded it.</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {phase === 'playing' ? (
              legalActions.map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={busy}
                  onClick={() => void act(a)}
                  className={`rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
                    a === 'Stand' ? 'bg-slate-200 text-slate-900 hover:bg-white' : 'bg-slate-800 text-slate-100 hover:bg-slate-700'
                  }`}
                >
                  {ACTION_LABEL[a]}
                  <span className="ml-1.5 font-mono text-[10px] text-slate-500">{SHORTCUT[a].toUpperCase()}</span>
                </button>
              ))
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void deal()}
                className="rounded-md bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? 'Dealing…' : 'Deal'}
                <span className="ml-1.5 font-mono text-[10px] text-emerald-900">D</span>
              </button>
            )}
            <span className="ml-auto text-[11px] text-slate-500">
              running {signed(count.running, 0)} · true {signed(count.true, 1)}
              {reshuffled && <span className="ml-2 text-sky-300">new shoe</span>}
            </span>
          </div>
        </div>
      </section>

      {/* The analysis, alongside */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4" aria-label="Live analysis" aria-live="polite">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Live analysis</h3>
        {!analysis ? (
          phase === 'settled' && lastForecast ? (
            <div className="mt-3 space-y-3">
              <p className="text-sm text-slate-300">Hand complete.</p>
              <div className="rounded-lg bg-slate-950/60 p-3 text-xs text-slate-400">
                <p className="font-semibold uppercase tracking-widest text-slate-500">What was forecast</p>
                <p className="mt-1">
                  Standing on the opening hand was worth win {pct(lastForecast.win)}, push {pct(lastForecast.push)},
                  lose {pct(lastForecast.lose)}.
                </p>
                <p className="mt-2">
                  This hand {outcome && outcome.net > 0 ? 'was won' : outcome && outcome.net < 0 ? 'was lost' : 'pushed'}, which
                  says nothing on its own about whether that forecast was right. It becomes evidence only alongside the
                  {' '}thousands of others in the record.
                </p>
              </div>
              <p className="text-sm text-slate-500">Deal again for the next analysis.</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">
              Deal to begin. Every figure here is solved from the cards actually left in the shoe.
            </p>
          )
        ) : (
          <div className="mt-3 space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              {([['Win', analysis.standOutcomes.win, 'text-emerald-300'], ['Push', analysis.standOutcomes.push, 'text-slate-300'], ['Lose', analysis.standOutcomes.lose, 'text-rose-300']] as const).map(([label, value, tone]) => (
                <div key={label} className="rounded-lg bg-slate-950/60 p-2">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
                  <p className={`font-mono text-lg ${tone}`}>{pct(value)}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">If you stand on {analysis.total}{analysis.soft ? ' (soft)' : ''} against {card(dealer!.upcard)}.</p>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Expected value per action</p>
              <ul className="mt-1.5 space-y-1">
                {analysis.actions.map((a) => (
                  <li key={a.action} className={`flex items-center justify-between rounded-md px-2 py-1 text-sm ${a.action === analysis.best.action ? 'bg-emerald-500/10 text-emerald-200' : 'text-slate-300'}`}>
                    <span>{ACTION_LABEL[a.action]}{a.action === analysis.best.action && <span className="ml-2 text-[10px] uppercase tracking-widest">recommended</span>}</span>
                    <span className="font-mono">{signed(a.ev, 4)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1 text-[11px] text-slate-400">
              <p className="font-semibold uppercase tracking-widest text-slate-400">Why</p>
              <p>
                The dealer busts {pct(analysis.dealerDistribution[5])} of the time from {card(dealer!.upcard)}, and reaches 17–21 the rest.
                Those probabilities are enumerated over the {analysis.unseenCards} cards you have not seen, not read from a table.
              </p>
              <p>
                {analysis.margin === null || analysis.margin > 0.05
                  ? `${ACTION_LABEL[analysis.best.action]} is clearly best here.`
                  : `${ACTION_LABEL[analysis.best.action]} is best by only ${analysis.margin.toFixed(4)} — close enough that the choice barely matters.`}
              </p>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Dealer final total</p>
              <div className="mt-1 space-y-1">
                {['17', '18', '19', '20', '21', 'bust'].map((label, i) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="w-8 font-mono text-[11px] text-slate-500">{label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${analysis.dealerDistribution[i] * 100 * 2.4}%` }} />
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
