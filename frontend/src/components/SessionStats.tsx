import { useState } from 'react';
import { TokenPrompt } from './TokenPrompt';
import type { CompletedHand } from './BlackjackTable';

const signed = (v: number, d = 2): string => (v >= 0 ? '+' : '') + v.toFixed(d);

/**
 * This session, separated into the part the player controls and the part they do not.
 *
 * Agreement with the solver is the first; the net is mostly the shoe. Keeping them apart is the
 * point: a losing session played perfectly and a winning one played badly both happen often, and a
 * single figure would hide which is which.
 */
export function SessionStats({ history }: { history: CompletedHand[] }) {
  const [dismissed, setDismissed] = useState(false);
  const hands = history.length;
  const decisions = history.reduce((sum, h) => sum + h.decisions.length, 0);
  const agreed = history.reduce((sum, h) => sum + h.decisions.filter((d) => d.chosen === d.recommended).length, 0);
  const evLost = history.reduce(
    (sum, h) => sum + h.decisions.reduce((inner, d) => {
      const best = Math.max(...d.actionEvs.map((a) => a.ev));
      const chosen = d.actionEvs.find((a) => a.action === d.chosen)?.ev ?? best;
      return inner + Math.max(0, best - chosen);
    }, 0),
    0,
  );
  const net = history.reduce((sum, h) => sum + h.net, 0);
  const won = history.filter((h) => h.net > 0).length;
  const lost = history.filter((h) => h.net < 0).length;
  const pushed = hands - won - lost;
  // Hands that settled on the deal are not observations by design and are not counted as missing.
  const unrecorded = history.filter((h) => h.recorded === 'unauthorised' || h.recorded === 'failed').length;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">This session</h3>
      {hands === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No hands yet.</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Stat label="Hands" value={String(hands)} />
            <Stat label="Won / lost / pushed" value={`${won} / ${lost} / ${pushed}`} />
            <Stat label="Net" value={signed(net)} tone={net > 0 ? 'good' : net < 0 ? 'bad' : undefined} />
            <Stat label="Decisions" value={String(decisions)} />
            <Stat label="Matched the solver" value={decisions === 0 ? '—' : `${((agreed / decisions) * 100).toFixed(0)}%`} />
            <Stat label="Lost to choices" value={`${evLost.toFixed(3)} bets`} tone={evLost > 0.01 ? 'bad' : undefined} />
          </dl>
          <p className="mt-3 text-[11px] text-slate-500">
            <span className="text-slate-400">Lost to choices</span> is what your decisions cost against the solver, and is the
            only figure here you control. The net is mostly the shoe: perfect play still loses about half a percent a hand.
          </p>
          {unrecorded > 0 && (
            <div className="mt-2 space-y-2">
              <p className="text-[11px] text-amber-300">
                {unrecorded} hand{unrecorded === 1 ? '' : 's'} not added to the observation record. Play is unaffected; the
                record is what the model is later judged against.
              </p>
              {!dismissed && history.some((h) => h.recorded === 'unauthorised') && (
                <TokenPrompt onSaved={() => setDismissed(true)} />
              )}
              {dismissed && <p className="text-[11px] text-slate-500">Saved. Hands from here on are recorded; the ones already played are not retried.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className={`font-mono ${tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : 'text-slate-100'}`}>{value}</dd>
    </div>
  );
}
