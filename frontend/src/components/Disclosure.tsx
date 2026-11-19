import { useState, type ReactNode } from 'react';

/** A section the page offers rather than imposes: closed until it is wanted. */
export function Disclosure({
  title, subtitle, children, defaultOpen = false, badge,
}: { title: string; subtitle?: string; children: ReactNode; defaultOpen?: boolean; badge?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/40"
      >
        <span aria-hidden className={`text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        <span className="flex-1">
          <span className="block text-sm font-semibold text-slate-200">{title}</span>
          {subtitle && <span className="mt-0.5 block text-xs text-slate-500">{subtitle}</span>}
        </span>
        {badge && <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">{badge}</span>}
      </button>
      {open && <div className="border-t border-slate-800 p-4">{children}</div>}
    </section>
  );
}
