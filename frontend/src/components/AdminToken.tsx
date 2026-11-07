import { useState } from 'react';
import { getAdminToken, setAdminToken } from '../services/api';

// Running an analysis, a debate, an import or a model change writes to the database, so those
// endpoints require the deployment token. Read-only pages need nothing. The token lives in this
// browser only — it is never part of the build.
export function AdminToken() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getAdminToken);
  const [saved, setSaved] = useState(false);
  const held = getAdminToken().length > 0;

  const save = () => {
    setAdminToken(value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`rounded-md border px-2.5 py-1 text-xs ${held ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
      >
        {held ? 'Token set' : 'Token'}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl">
          <label htmlFor="adminToken" className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Deployment token
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Needed to run an analysis or debate, import data, or change a model. Browsing needs nothing.
          </p>
          <input
            id="adminToken"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste the token"
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-200"
          />
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={save} className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-emerald-400">
              Save
            </button>
            <button
              type="button"
              onClick={() => { setValue(''); setAdminToken(''); }}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
            >
              Clear
            </button>
            {saved && <span className="text-xs text-emerald-400">Saved</span>}
          </div>
          <p className="mt-2 text-[11px] text-slate-600">Stored in this browser only.</p>
        </div>
      )}
    </div>
  );
}
