import { useState } from 'react';
import type { PlayedHand } from './BlackjackAdvisor';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const card = (rank: number): string => RANKS[rank] ?? '?';
const cards = (list: readonly number[]): string => (list.length ? list.map(card).join(' ') : '—');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** Hands entered this session, newest first, openable down to the advice each decision got. */
export function HandHistory({ history }: { history: PlayedHand[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (history.length === 0) return <p className="text-sm text-slate-500">No hands entered yet in this session.</p>;

  return (
    <ul className="space-y-1">
      {[...history].reverse().map((h) => {
        const expanded = open === h.id;
        const against = h.decisions.filter((d) => d.chosen !== d.recommended).length;
        return (
          <li key={h.id} className="rounded-lg border border-slate-800 bg-slate-900/40">
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : h.id)}
              aria-expanded={expanded}
              className="grid w-full grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2 text-left hover:bg-slate-800/40"
            >
              <span className="font-mono text-[11px] text-slate-600">#{h.id}</span>
              <span className="truncate text-sm text-slate-300">
                <span className="font-mono">{cards(h.playerFinal)}</span>
                <span className="mx-2 text-slate-600">vs</span>
                <span className="font-mono">{card(h.dealerUpcard)}</span>
                {h.dealerFinal.length > 0 && <span className="ml-3 text-slate-500">dealer {cards(h.dealerFinal)}</span>}
              </span>
              {against > 0 && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">{against} against advice</span>}
              <span className={`text-sm ${h.reported === 'win' ? 'text-emerald-300' : h.reported === 'lose' ? 'text-rose-300' : 'text-slate-400'}`}>
                {h.reported}
              </span>
            </button>

            {expanded && (
              <div className="space-y-3 border-t border-slate-800 p-3 text-sm">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Fact label="You said">{h.reported}{h.computed && h.computed !== h.reported ? ` — the cards entered say ${h.computed}` : ''}</Fact>
                  <Fact label="Advice before acting">
                    {h.openingForecast
                      ? `stand: win ${pct(h.openingForecast.win)} · push ${pct(h.openingForecast.push)} · lose ${pct(h.openingForecast.lose)}`
                      : 'no decision was logged'}
                  </Fact>
                  <Fact label="In the observation record">
                    {h.recorded === 'yes' ? 'yes'
                      : h.recorded === 'unauthorised' ? 'no — needs the deployment token'
                      : h.recorded === 'failed' ? 'no — the write failed'
                      : 'no — the dealer’s final cards were not entered'}
                  </Fact>
                  <Fact label="Dealer">{cards(h.dealerFinal)}</Fact>
                </div>

                {h.decisions.length > 0 && (
                  <table className="w-full text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th scope="col" className="text-left">Holding</th>
                        <th scope="col" className="text-left">You</th>
                        <th scope="col" className="text-left">Advice</th>
                        <th scope="col" className="text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.decisions.map((d, i) => {
                        const best = Math.max(...d.actionEvs.map((a) => a.ev));
                        const chosen = d.actionEvs.find((a) => a.action === d.chosen)?.ev ?? best;
                        const cost = Math.max(0, best - chosen);
                        return (
                          <tr key={i} className="border-t border-slate-800">
                            <td className="py-1 font-mono text-slate-300">{cards(d.cards)} <span className="text-slate-500">({d.total}{d.soft ? ' soft' : ''})</span></td>
                            <td className={d.chosen === d.recommended ? 'text-slate-300' : 'text-amber-300'}>{d.chosen}</td>
                            <td className="text-slate-400">{d.recommended}</td>
                            <td className="text-right font-mono text-slate-400">{cost > 0 ? `−${cost.toFixed(4)}` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <p className="text-[11px] text-slate-500">
                  A cost is what a choice gave up against the solver — a fact about the decision. Whether this hand was won
                  is not: one hand says nothing about a forecast.
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="text-slate-300">{children}</p>
    </div>
  );
}
