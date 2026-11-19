import { useState } from 'react';
import { TokenPrompt } from './TokenPrompt';
import type { PlayedHand } from './BlackjackAdvisor';

const signed = (v: number, d = 2): string => (v >= 0 ? '+' : '') + v.toFixed(d);

/**
 * This session, with what the player controls kept apart from what they do not.
 *
 * Agreement with the solver is the first. The record of wins and losses is the second, and over a
 * session it says far more about the shoe than about how the hands were played.
 */
export function SessionStats({ history }: { history: PlayedHand[] }) {
  const [dismissed, setDismissed] = useState(false);
  const hands = history.length;
  const decisions = history.reduce((sum, h) => sum + h.decisions.length, 0);
  const followed = history.reduce((sum, h) => sum + h.decisions.filter((d) => d.chosen === d.recommended).length, 0);
  const won = history.filter((h) => h.reported === 'win').length;
  const lost = history.filter((h) => h.reported === 'lose').length;
  const pushed = history.filter((h) => h.reported === 'push').length;
  const recorded = history.filter((h) => h.recorded === 'yes').length;
  const needsToken = history.some((h) => h.recorded === 'unauthorised');
  const mismatched = history.filter((h) => h.computed !== null && h.computed !== h.reported).length;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">This session</h3>
      {hands === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No hands yet. Enter one and tell it how the hand went.</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Stat label="Hands" value={String(hands)} />
            <Stat label="You reported W/L/P" value={`${won} / ${lost} / ${pushed}`} />
            <Stat label="In the record" value={`${recorded} of ${hands}`} />
            <Stat label="Decisions logged" value={String(decisions)} />
            <Stat label="Took the advice" value={decisions === 0 ? '—' : `${((followed / decisions) * 100).toFixed(0)}%`} />
            <Stat label="Net reported" value={signed(won - lost)} tone={won > lost ? 'good' : won < lost ? 'bad' : undefined} />
          </dl>
          <p className="mt-3 text-[11px] text-slate-500">
            A session that loses is not evidence the advice was wrong, and one that wins is not evidence it was right.
            Perfect play still loses about half a percent a hand. What the advice is actually judged on is the record
            below — thousands of hands, scored against what was forecast before each one.
          </p>
          {mismatched > 0 && (
            <p className="mt-1 text-[11px] text-amber-300">
              {mismatched} hand{mismatched === 1 ? '' : 's'} where the result you gave differs from the cards you entered.
              Your answer was recorded either way; worth a glance in case a card was mistyped.
            </p>
          )}
          {needsToken && !dismissed && (
            <div className="mt-3">
              <TokenPrompt onSaved={() => setDismissed(true)} />
            </div>
          )}
          {dismissed && <p className="mt-2 text-[11px] text-slate-500">Saved. Hands from here on join the record.</p>}
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
