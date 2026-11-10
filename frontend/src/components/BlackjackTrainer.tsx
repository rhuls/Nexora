import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type BlackjackAction, type BlackjackDecision, type BlackjackRules,
  type TrainerDeal, type TrainerSettlement,
} from '../services/api';
import { Card, ErrorBox } from './ui';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const card = (rank: number): string => RANKS[rank] ?? '?';
const signed = (v: number, digits = 3): string => (v >= 0 ? '+' : '') + v.toFixed(digits);

// What the trainer has learned about this player, kept in their own browser. It is per-person by
// nature — the point is which hands *you* misplay — and it is the input that decides what gets
// dealt next, so it is the whole of the learning loop.
const LEAK_KEY = 'nexora.blackjack.leaks.v1';
const TALLY_KEY = 'nexora.blackjack.tally.v1';

export interface Leak {
  key: string;
  label: string;
  attempts: number;
  misses: number;
  evLost: number;
  // What the player says happened in this situation, which is the only account of the result the
  // trainer has when the hand was played at a real table rather than dealt here.
  won: number;
  lost: number;
  pushed: number;
}

interface Tally {
  hands: number;
  decisions: number;
  mistakes: number;
  evLost: number;
  net: number;
  won: number;
  lost: number;
  pushed: number;
  // The solver's value of each hand at the first decision, summed. Comparing it with the reported
  // net is what separates a bad run from bad play.
  expectedEv: number;
  disagreements: number;
}

const EMPTY_TALLY: Tally = { hands: 0, decisions: 0, mistakes: 0, evLost: 0, net: 0, won: 0, lost: 0, pushed: 0, expectedEv: 0, disagreements: 0 };

type Reported = 'win' | 'lose' | 'push';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the session still works, it just will not be remembered.
  }
}

interface PlayHand {
  cards: number[];
  stake: number;
  surrendered: boolean;
  done: boolean;
  fromSplit: boolean;
}

interface Graded {
  chosen: BlackjackAction;
  best: BlackjackAction;
  evLost: number;
  decision: BlackjackDecision;
  situationLabel: string;
}

export function BlackjackTrainer({ rules }: { rules: BlackjackRules }) {
  const [seen, setSeen] = useState<number[]>([]);
  const [deal, setDeal] = useState<TrainerDeal | null>(null);
  const [hands, setHands] = useState<PlayHand[]>([]);
  const [active, setActive] = useState(0);
  const [graded, setGraded] = useState<Graded | null>(null);
  const [settlement, setSettlement] = useState<TrainerSettlement | null>(null);
  // A hand that has been played out and is waiting for the player to say how it went.
  const [pending, setPending] = useState<{ hands: PlayHand[]; seen: number[] } | null>(null);
  const [reported, setReported] = useState<Reported | null>(null);
  const [handExpectedEv, setHandExpectedEv] = useState(0);
  const [handSituation, setHandSituation] = useState<{ key: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaks, setLeaks] = useState<Record<string, Leak>>(() => load<Record<string, Leak>>(LEAK_KEY, {}));
  const [tally, setTally] = useState<Tally>(() => load<Tally>(TALLY_KEY, EMPTY_TALLY));
  const started = useRef(false);

  useEffect(() => { save(LEAK_KEY, leaks); }, [leaks]);
  useEffect(() => { save(TALLY_KEY, tally); }, [tally]);

  const weak = useMemo(
    () => Object.values(leaks).filter((l) => l.evLost > 0).sort((a, b) => b.evLost - a.evLost).slice(0, 40).map((l) => ({ key: l.key, evLost: l.evLost })),
    [leaks],
  );

  const settle = useCallback(async (finished: PlayHand[], d: TrainerDeal, seenNow: number[]) => {
    const result = await api.trainerSettle({
      rules,
      seen: seenNow,
      dealer: [d.upcard, d.hole],
      hands: finished.map((h) => ({ cards: h.cards, stake: h.stake, surrendered: h.surrendered })),
    });
    setSettlement(result);
    setSeen((s) => [...s, d.hole, ...result.drawn]);
    return result;
  }, [rules]);

  const newHand = useCallback(async () => {
    setBusy(true);
    setError(null);
    setGraded(null);
    setSettlement(null);
    setPending(null);
    setReported(null);
    setHandSituation(null);
    setHandExpectedEv(0);
    try {
      const d = await api.trainerDeal({ rules, seen, weak, drillBias: 0.5 });
      const nextSeen = d.reshuffled ? [...d.player, d.upcard] : [...seen, ...d.player, d.upcard];
      const opening: PlayHand[] = [{ cards: d.player, stake: 1, surrendered: false, done: d.legalActions.length === 0, fromSplit: false }];
      setSeen(nextSeen);
      setDeal(d);
      setHands(opening);
      setActive(0);
      // A natural on either side ends the hand before anyone acts. There is no decision to grade,
      // but the player still reports it, so the session is one account of every hand played.
      if (d.legalActions.length === 0) {
        setHandSituation({ key: d.situation.key, label: d.situation.label });
        // Nobody chose anything, but the hand still has a known value: a natural settles at the
        // table rate, and a dealer natural takes the bet.
        setHandExpectedEv(d.playerNatural ? (d.dealerNatural ? 0 : rules.blackjackPays) : d.dealerNatural ? -1 : 0);
        setPending({ hands: opening, seen: nextSeen });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [rules, seen, weak, settle]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void newHand();
    // Only ever on first mount: every later deal is the player's own doing.
  }, [newHand]);


  const act = async (action: BlackjackAction) => {
    if (!deal || busy) return;
    const hand = hands[active];
    if (!hand || hand.done) return;
    setBusy(true);
    setError(null);
    try {
      // Grade against the solver before the card comes out, so the verdict is about the decision
      // and not about how it happened to turn out.
      // Every card dealt so far is tracked locally through this handler, because React state set
      // here does not land until the next render and settlement must not re-deal a spent card.
      let seenNow = [...seen];
      const decision = await api.blackjackEvaluate({
        hand: hand.cards,
        upcard: deal.upcard,
        seen: seenNow,
        afterSplit: hand.fromSplit,
        rules,
      });
      const best = decision.best.action as BlackjackAction;
      const chosenEV = decision.actions.find((a) => a.action === action)?.ev ?? decision.best.ev;
      const evLost = Math.max(0, decision.best.ev - chosenEV);
      const situation = hand.cards.length === 2 && hand.cards[0] === hand.cards[1]
        ? { key: `pair:${hand.cards[0]}:${deal.upcard}`, label: `pair of ${card(hand.cards[0])}s vs ${card(deal.upcard)}` }
        : { key: `${decision.soft ? 'soft' : 'hard'}:${decision.total}:${deal.upcard}`, label: `${decision.soft ? 'soft' : 'hard'} ${decision.total} vs ${card(deal.upcard)}` };

      setGraded({ chosen: action, best, evLost, decision, situationLabel: situation.label });
      // The first decision of a hand is where the solver's value of that hand is read from.
      if (handSituation === null) {
        setHandSituation({ key: situation.key, label: situation.label });
        setHandExpectedEv(decision.best.ev);
      }
      setTally((t) => ({ ...t, decisions: t.decisions + 1, mistakes: t.mistakes + (action === best ? 0 : 1), evLost: t.evLost + evLost }));
      setLeaks((prev) => {
        const current: Leak = prev[situation.key] ?? { key: situation.key, label: situation.label, attempts: 0, misses: 0, evLost: 0, won: 0, lost: 0, pushed: 0 };
        return {
          ...prev,
          [situation.key]: {
            ...current,
            attempts: current.attempts + 1,
            misses: current.misses + (action === best ? 0 : 1),
            evLost: current.evLost + evLost,
          },
        };
      });

      // Then carry the action out.
      const next = hands.map((h) => ({ ...h, cards: [...h.cards] }));
      const h = next[active];
      if (action === 'Stand') h.done = true;
      else if (action === 'Surrender') { h.surrendered = true; h.done = true; }
      else if (action === 'Hit' || action === 'Double') {
        const { cards } = await api.trainerDraw({ rules, seen: seenNow, count: 1 });
        h.cards.push(cards[0]);
        seenNow = [...seenNow, cards[0]];
        if (action === 'Double') { h.stake = 2; h.done = true; }
        if (handTotal(h.cards) >= 21) h.done = true;
      } else if (action === 'Split') {
        // One card to each half, so both hands are playable immediately.
        const [rank] = h.cards;
        const { cards } = await api.trainerDraw({ rules, seen: seenNow, count: 2 });
        seenNow = [...seenNow, ...cards];
        h.cards = [rank, cards[0]];
        h.fromSplit = true;
        const second: PlayHand = { cards: [rank, cards[1]], stake: 1, surrendered: false, done: false, fromSplit: true };
        // Split aces get one card each and then stand, as at a table.
        if (rank === 0) { h.done = true; second.done = true; }
        next.push(second);
      }
      setHands(next);
      setSeen(seenNow);

      const nextIndex = next.findIndex((x) => !x.done);
      setActive(nextIndex === -1 ? active : nextIndex);
      // The hand is over, but the trainer does not decide how it went: the player says.
      if (nextIndex === -1) setPending({ hands: next, seen: seenNow });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The player's account of the hand is what the session is built from. The cards are then turned
  // over, because when the trainer dealt them it knows the answer, and a mismatch is worth saying
  // out loud rather than quietly recording the wrong thing.
  const report = async (outcome: Reported) => {
    if (!pending || !deal || busy) return;
    setBusy(true);
    setError(null);
    setReported(outcome);
    const stake = pending.hands.reduce((sum, h) => sum + (h.surrendered ? 0.5 : h.stake), 0);
    // A natural pays the table rate rather than the stake, so a reported win on one is worth more.
    const naturalWin = deal.playerNatural && !deal.dealerNatural;
    const net = outcome === 'push' ? 0 : outcome === 'win' ? (naturalWin ? rules.blackjackPays : stake) : -stake;
    const situation = handSituation;

    setTally((t) => ({
      ...t,
      hands: t.hands + 1,
      net: t.net + net,
      won: t.won + (outcome === 'win' ? 1 : 0),
      lost: t.lost + (outcome === 'lose' ? 1 : 0),
      pushed: t.pushed + (outcome === 'push' ? 1 : 0),
      expectedEv: t.expectedEv + handExpectedEv,
    }));
    if (situation) {
      setLeaks((prev) => {
        const current: Leak = prev[situation.key] ?? { key: situation.key, label: situation.label, attempts: 0, misses: 0, evLost: 0, won: 0, lost: 0, pushed: 0 };
        return {
          ...prev,
          [situation.key]: {
            ...current,
            won: current.won + (outcome === 'win' ? 1 : 0),
            lost: current.lost + (outcome === 'lose' ? 1 : 0),
            pushed: current.pushed + (outcome === 'push' ? 1 : 0),
          },
        };
      });
    }

    try {
      const result = await settle(pending.hands, deal, pending.seen);
      const actual = result.net > 0 ? 'win' : result.net < 0 ? 'lose' : 'push';
      if (actual !== outcome) setTally((t) => ({ ...t, disagreements: t.disagreements + 1 }));
    } catch (e) {
      // Reporting still counts even if the reveal fails; the player's account is the record.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const reset = () => {
    setLeaks({});
    setTally(EMPTY_TALLY);
  };

  const accuracy = tally.decisions === 0 ? null : 1 - tally.mistakes / tally.decisions;
  // A situation earns a row once it has cost something or has a reported result against it, so a
  // spot played correctly but lost repeatedly is still visible.
  const topLeaks = Object.values(leaks)
    .filter((l) => l.misses > 0 || l.won + l.lost + l.pushed > 0)
    .sort((a, b) => b.evLost - a.evLost || (b.lost - b.won) - (a.lost - a.won))
    .slice(0, 10);
  const hand = hands[active];
  const legal = useMemo(() => {
    if (!deal || !hand || hand.done) return [] as BlackjackAction[];
    const total = handTotal(hand.cards);
    if (total >= 21) return [];
    const out: BlackjackAction[] = ['Stand', 'Hit'];
    const two = hand.cards.length === 2;
    if (two && (rules.doubleAnyTwo || (total >= 9 && total <= 11)) && (!hand.fromSplit || rules.das)) out.push('Double');
    if (two && hand.cards[0] === hand.cards[1] && !hand.fromSplit && hands.length < 2) out.push('Split');
    if (rules.surrender && two && !hand.fromSplit) out.push('Surrender');
    return out;
  }, [deal, hand, hands.length, rules]);

  return (
    <div className="space-y-6">
      <Card
        title="Trainer"
        subtitle="A new hand every time. You make the call, then you tell it how the hand ended. Each decision is graded against the exact solver before the card comes out, and the hands you keep getting wrong come round more often."
      >
        {error && <ErrorBox message={error} />}

        {deal && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Dealer</p>
                  <div className="mt-1 flex gap-1.5">
                    <Chip>{card(settlement ? settlement.dealer[0] : deal.upcard)}</Chip>
                    {settlement
                      ? settlement.dealer.slice(1).map((c, i) => <Chip key={i}>{card(c)}</Chip>)
                      : <Chip hidden>?</Chip>}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    You{hands.length > 1 ? ` · hand ${active + 1} of ${hands.length}` : ''}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {hands.map((h, i) => (
                      <div key={i} className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 ${i === active && !settlement ? 'bg-emerald-500/10 ring-1 ring-emerald-500/40' : ''}`}>
                        {h.cards.map((c, j) => <Chip key={j}>{card(c)}</Chip>)}
                        <span className="ml-1 font-mono text-sm text-slate-400">{handTotal(h.cards)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="text-right text-xs text-slate-400">
                <p>Running count <span className="font-mono text-slate-200">{signed(deal.count.running, 0)}</span></p>
                <p>True count <span className="font-mono text-slate-200">{signed(deal.count.true, 1)}</span></p>
                {deal.drilled && <p className="mt-1 text-amber-300">drilling a weak spot</p>}
                {deal.reshuffled && <p className="mt-1 text-sky-300">new shoe</p>}
              </div>
            </div>

            {!settlement && legal.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {legal.map((a) => (
                  <button
                    key={a}
                    type="button"
                    disabled={busy}
                    onClick={() => void act(a)}
                    className="rounded-md bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-50"
                  >
                    {a}
                  </button>
                ))}
              </div>
            )}

            {graded && <Verdict graded={graded} />}

            {pending && (
              <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3" aria-live="polite">
                <p className="text-sm font-semibold text-sky-200">How did this hand end?</p>
                <p className="mt-0.5 text-xs text-sky-200/80">
                  Your answer is what the session records. Tell it the result you actually got, whether this hand was
                  dealt here or at a table.
                </p>
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
                </div>
              </div>
            )}

            {settlement && <Result settlement={settlement} reported={reported} />}

            <button
              type="button"
              disabled={busy || pending !== null}
              onClick={() => void newHand()}
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? 'Dealing…' : pending ? 'Tell it how the hand ended first' : 'New hand'}
            </button>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="This session" subtitle="Built from what you reported. Decisions are what you control; the result is mostly the shoe.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Stat label="Hands" value={String(tally.hands)} />
            <Stat label="Decisions" value={String(tally.decisions)} />
            <Stat label="Correct" value={accuracy === null ? '—' : `${(accuracy * 100).toFixed(1)}%`} />
            <Stat label="Mistakes" value={String(tally.mistakes)} />
            <Stat label="Lost to mistakes" value={`${tally.evLost.toFixed(3)} bets`} />
            <Stat label="Net" value={signed(tally.net, 2)} />
            <Stat label="You reported W/L/P" value={`${tally.won} / ${tally.lost} / ${tally.pushed}`} />
            <Stat label="Your play was worth" value={tally.hands === 0 ? '—' : signed(tally.expectedEv, 2)} />
            <Stat label="You actually got" value={signed(tally.net, 2)} />
            <Stat label="Luck (actual − worth)" value={tally.hands === 0 ? '—' : signed(tally.net - tally.expectedEv, 2)} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            Perfect play still loses about 0.42% a hand at these rules, so a losing session is not evidence of a mistake
            and a winning one is not evidence you played well. <span className="text-slate-400">Lost to mistakes</span> is
            the part you control. <span className="text-slate-400">Luck</span> is the rest, and over enough hands it
            trends to nothing — if it stays heavily negative while your mistakes stay near zero, the table is not paying
            what these rules say it should.
          </p>
          {tally.disagreements > 0 && (
            <p className="mt-2 text-xs text-amber-300">
              {tally.disagreements} reported {tally.disagreements === 1 ? 'result differs' : 'results differ'} from the cards
              dealt here. Expected if you are playing at a real table; worth a look if you are not.
            </p>
          )}
          <button type="button" onClick={reset} className="mt-3 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-rose-500 hover:text-rose-300">
            Reset what the trainer has learned
          </button>
        </Card>

        <Card title="Your leaks" subtitle="Ranked by what they have actually cost, not by how often they come up.">
          {topLeaks.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing yet. Play hands and report how they went: anything you misplay is listed here and dealt to you more often.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr><th scope="col" className="text-left">Situation</th><th scope="col">Missed</th><th scope="col">Cost</th><th scope="col">Your W/L/P</th></tr>
              </thead>
              <tbody>
                {topLeaks.map((l) => (
                  <tr key={l.key} className="border-t border-slate-800">
                    <td className="py-1">{l.label}</td>
                    <td className="text-center font-mono text-slate-300">{l.misses}/{l.attempts}</td>
                    <td className="text-center font-mono text-rose-300">{l.evLost.toFixed(3)}</td>
                    <td className="text-center font-mono text-slate-400">{l.won}/{l.lost}/{l.pushed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Chip({ children, hidden = false }: { children: React.ReactNode; hidden?: boolean }) {
  return (
    <span className={`inline-flex h-9 w-7 items-center justify-center rounded-md border font-mono text-sm ${hidden ? 'border-slate-700 bg-slate-800 text-slate-500' : 'border-slate-600 bg-slate-100 text-slate-900'}`}>
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-mono text-slate-100">{value}</dd>
    </>
  );
}

function Verdict({ graded }: { graded: Graded }) {
  const right = graded.chosen === graded.best;
  const bust = graded.decision.dealerDistribution[5];
  return (
    <div className={`rounded-lg border p-3 ${right ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10'}`} aria-live="polite">
      <p className={`text-sm font-semibold ${right ? 'text-emerald-200' : 'text-rose-200'}`}>
        {right ? `Correct — ${graded.best} is the play` : `${graded.chosen} is wrong: ${graded.best} is the play`}
        <span className="ml-2 font-normal text-slate-300">({graded.situationLabel})</span>
      </p>
      {!right && (
        <p className="mt-0.5 text-xs text-rose-200/80">
          That choice costs {graded.evLost.toFixed(4)} of a bet every time you make it.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-300">
        {graded.decision.actions.map((a) => (
          <span key={a.action} className={a.action === graded.best ? 'text-emerald-300' : ''}>
            {a.action} {signed(a.ev, 4)}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        Dealer busts {(bust * 100).toFixed(1)}% of the time from here, solved over the {graded.decision.unseenCards} cards you have not seen.
      </p>
    </div>
  );
}

function Result({ settlement, reported }: { settlement: TrainerSettlement; reported: Reported | null }) {
  const tone = settlement.net > 0 ? 'text-emerald-300' : settlement.net < 0 ? 'text-rose-300' : 'text-slate-300';
  const actual: Reported = settlement.net > 0 ? 'win' : settlement.net < 0 ? 'lose' : 'push';
  const disagrees = reported !== null && reported !== actual;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" aria-live="polite">
      <p className={`text-sm font-semibold ${tone}`}>
        These cards: {settlement.hands.map((h) => h.outcome).join(', ')} · net {signed(settlement.net, 2)}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">
        Dealer finished on {handTotal(settlement.dealer)} ({settlement.dealer.map(card).join(' ')}).
      </p>
      {disagrees && (
        <p className="mt-1 text-xs text-amber-300">
          You reported a {reported === 'win' ? 'win' : reported === 'lose' ? 'loss' : 'push'}, and the cards dealt here
          say otherwise. Your answer is what was recorded — this note is only here in case it was a misclick.
        </p>
      )}
    </div>
  );
}

/* Display only: the graded totals all come from the solver. */
function handTotal(cards: readonly number[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c === 0) { aces += 1; total += 11; } else total += Math.min(c + 1, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}
