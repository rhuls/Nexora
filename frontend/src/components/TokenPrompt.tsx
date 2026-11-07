import { useState } from 'react';
import { setAdminToken } from '../services/api';

// Shown where a request was refused, rather than sending the reader off to find a control in the
// header. Running an analysis, a debate, an import or a model change writes to the database, so
// those endpoints need the deployment token; reading needs nothing.
export function TokenPrompt({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');

  const save = () => {
    const token = value.trim();
    if (!token) return;
    setAdminToken(token);
    onSaved();
  };

  return (
    <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="text-sm font-semibold text-amber-200">This action needs the deployment token</p>
      <p className="mt-1 text-xs text-amber-200/80">
        Reading is open; running an analysis writes to the database, so it is guarded. Paste the token once and it is
        remembered in this browser.
      </p>
      <p className="mt-2 font-mono text-[11px] text-amber-200/70">grep &apos;^NEXORA_API_TOKEN=&apos; .env | cut -d= -f2-</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="inlineToken">Deployment token</label>
        <input
          id="inlineToken"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder="paste the token"
          className="min-w-0 flex-1 rounded-md border border-amber-500/40 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-200"
        />
        <button type="button" onClick={save} className="rounded-md bg-amber-400 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-amber-300">
          Save and retry
        </button>
      </div>
    </div>
  );
}
