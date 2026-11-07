import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, EnvBadge, ErrorBox, FormPills, List, Loading, MetricValue, Unavailable, fmtDate } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';

export function TeamsPage() {
  const competitions = useApi(() => api.competitions(), []);
  const [competitionId, setCompetitionId] = useState<string>('');
  // One competition at a time so SYNTHETIC teams never appear alongside real clubs; default to real data.
  const items = competitions.data?.items ?? [];
  const selected = competitionId || (items.find((c) => c.dataEnvironment !== 'SYNTHETIC') ?? items[0])?.id || '';
  const teams = useApi(
    () => (selected ? api.teams(selected) : new Promise<Awaited<ReturnType<typeof api.teams>>>(() => {})),
    [selected],
  );
  return (
    <Card title="Teams">
      <label className="mb-4 flex items-center gap-2 text-sm">
        Competition
        <select className="rounded bg-slate-800 px-2 py-1" value={selected} onChange={(e) => setCompetitionId(e.target.value)}>
          {items.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.dataEnvironment})</option>)}
        </select>
      </label>
      {competitions.error ? <ErrorBox message={competitions.error} /> : teams.loading ? <Loading /> : teams.error ? <ErrorBox message={teams.error} /> : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {teams.data!.items.map((t) => (
            <li key={t.id}><Link className="block rounded-lg bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-800" to={`/teams/${encodeURIComponent(t.id)}`}>{t.name} <span className="text-xs text-slate-500">{t.shortName}</span></Link></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TeamPage() {
  const { id = '' } = useParams();
  const team = useApi(() => api.team(id), [id]);
  const form = useApi(() => api.teamForm(id), [id]);
  const players = useApi(() => api.teamPlayers(id), [id]);
  const matches = useApi(() => api.matches({ teamId: id, limit: 10, order: 'desc', status: 'FINISHED' }), [id]);

  if (team.loading) return <Loading />;
  if (team.error) return <ErrorBox message={team.error} />;
  const o = form.data?.overall;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{team.data!.name} <span className="text-sm font-normal text-slate-400">{team.data!.competition.name}</span></h1>
      <Card title="Current form" subtitle={form.data ? `As of ${fmtDate(form.data.asOf)}` : undefined}>
        {form.loading ? <Loading /> : form.error ? <ErrorBox message={form.error} /> : o && (
          <div className="grid gap-4 sm:grid-cols-3 text-sm">
            <div><FormPills sequence={o.sequence} /><p className="mt-1 text-slate-400">{o.record.wins}W {o.record.draws}D {o.record.losses}L</p></div>
            <div>Goals for <MetricValue metric={o.averageGoalsScored} /> · against <MetricValue metric={o.averageGoalsConceded} /></div>
            <div>Shots <MetricValue metric={o.averageShots} /> · corners <MetricValue metric={o.averageCorners} /></div>
            <div className="sm:col-span-3"><List items={o.limitations} empty="No data limitations." /></div>
          </div>
        )}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent results">
          {matches.loading ? <Loading /> : matches.data?.items.length === 0 ? <p className="text-sm text-slate-400">No finished matches.</p> : (
            <ul className="text-sm">
              {matches.data?.items.map((m) => (
                <li key={m.id} className="flex items-center justify-between border-t border-slate-800 py-1.5">
                  <Link className="hover:underline" to={`/matches/${encodeURIComponent(m.id)}`}>{m.homeTeam.name} {m.homeScore}–{m.awayScore} {m.awayTeam.name}</Link>
                  <span className="flex items-center gap-2 text-xs text-slate-500">{fmtDate(m.matchDate, false)} <EnvBadge env={m.dataEnvironment} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Squad">
          {players.loading ? <Loading /> : players.data?.players.length === 0 ? <Unavailable label="No player data from this source" /> : (
            <ul className="grid grid-cols-2 gap-1 text-sm">
              {players.data?.players.map((p) => <li key={p.id}><Link className="hover:underline" to={`/players/${encodeURIComponent(p.id)}`}>{p.name}</Link> <span className="text-xs text-slate-500">{p.position.toLowerCase()}</span></li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export function PlayerPage() {
  const { id = '' } = useParams();
  const player = useApi(() => api.player(id), [id]);
  if (player.loading) return <Loading />;
  if (player.error) return <ErrorBox message={player.error} />;
  const p = player.data!;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{p.name} <span className="text-sm font-normal text-slate-400">{p.position.toLowerCase()} · <Link className="hover:underline" to={`/teams/${encodeURIComponent(p.team.id)}`}>{p.team.name}</Link></span></h1>
      <Card title="Impact" subtitle="Explainable score from known appearances; associations, not causes">
        {p.impact.impactScore === undefined || p.impact.impactScore === null ? (
          <div><Unavailable /><List items={p.impact.limitations ?? []} empty="" /></div>
        ) : (
          <div className="text-sm">
            <p className="text-2xl font-bold">{p.impact.impactScore}<span className="text-sm text-slate-400">/100</span> <span className="text-sm text-slate-400">confidence {p.impact.impactConfidence}</span></p>
            <List items={p.impact.factors ?? []} empty="" />
          </div>
        )}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent matches">
          {p.recentMatches.length === 0 ? <Unavailable label="No player statistics" /> : (
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500"><tr><th scope="col" className="text-left">Date</th><th scope="col">Min</th><th scope="col">G</th><th scope="col">A</th><th scope="col">Shots</th></tr></thead>
              <tbody>{p.recentMatches.map((r) => <tr key={r.matchId} className="border-t border-slate-800 text-center"><td className="py-1 text-left"><Link className="hover:underline" to={`/matches/${encodeURIComponent(r.matchId)}`}>{fmtDate(r.matchDate, false)}</Link></td><td>{r.minutes}</td><td>{String(r.goals)}</td><td>{String(r.assists)}</td><td>{String(r.shots)}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
        <Card title="Availability history">
          <List items={p.availabilityHistory.map((a) => `${fmtDate(a.reportedAt, false)}: ${a.status}${a.reason ? ` (${a.reason})` : ''}`)} empty="No availability reports." />
        </Card>
      </div>
    </div>
  );
}
