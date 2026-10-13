import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, getToken, setToken, SIGNED_OUT_EVENT, money, STAGES, SERVICES, vehicleName, personName, formatPhone } from './api';

/* ---------- tiny hash router ---------- */
function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.slice(1);
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    fn().then(setData).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload, setData };
}

/** Bar darkness for a stage: 70% film lets 70% of light through, so it is 30% dark. */
const shadeOpacity = (vlt: number) => (0.12 + (1 - vlt / 100) * 0.88).toFixed(2);

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const SOURCE_LABEL: Record<string, string> = {
  sms: 'Text', text: 'Text', whatsapp: 'WhatsApp', instagram: 'Instagram', tiktok: 'TikTok', website: 'Website',
  'walk-in': 'Walk-in', referral: 'Referral', funnel: 'Funnel', dealer: 'Dealer', warranty: 'Warranty',
};
const sourceLabel = (s?: string | null) => (s ? SOURCE_LABEL[s] ?? s : null);

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const route = useRoute();
  useEffect(() => {
    const out = () => setAuthed(false);
    addEventListener(SIGNED_OUT_EVENT, out);
    return () => removeEventListener(SIGNED_OUT_EVENT, out);
  }, []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  let page: ReactNode;
  const jobMatch = route.match(/^\/jobs\/([0-9a-f-]{36})$/);
  if (jobMatch) page = <JobPage id={jobMatch[1]} />;
  else if (route === '/new') page = <QuickLead />;
  else if (route === '/warranty') page = <WarrantyLookup />;
  else page = <Board />;

  const nav = [['#/', 'Pipeline'], ['#/warranty', 'Warranties']];
  const active = (href: string) => (href === '#/' ? route === '/' || route.startsWith('/jobs')
    : href === '#/new' ? route === '/new' : `#${route}` === href);
  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">Da Spot 214<span>CRM</span></a>
        <nav className="nav" aria-label="Main">
          {nav.map(([href, label]) => <a key={href} href={href} aria-current={active(href) ? 'page' : undefined}>{label}</a>)}
        </nav>
        <span className="spacer" />
        <a className="btn new-btn" href="#/new">New lead</a>
      </header>
      <main>{page}</main>
      {/* Phones: thumb-reach navigation. Hidden on wider screens. */}
      <nav className="tabbar" aria-label="Main">
        <a href="#/" aria-current={active('#/') ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></svg>
          Pipeline
        </a>
        <a href="#/new" className="tab-new" aria-current={active('#/new') ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          New lead
        </a>
        <a href="#/warranty" aria-current={active('#/warranty') ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>
          Warranties
        </a>
      </nav>
    </>
  );
}

/* ---------- sign in ---------- */
function Login({ onDone }: { onDone: () => void }) {
  const [token, setT] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setToken(token.trim());
    try {
      await api('/pipeline');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That access code didn\'t work. Check it with the shop owner.' : (err as Error).message);
    }
  };
  return (
    <div className="login panel">
      <form className="form" onSubmit={submit}>
        <div>
          <h1>Da Spot 214</h1>
          <p className="muted" style={{ margin: 0 }}>Sign in to the shop CRM.</p>
        </div>
        <label>Shop access code
          <input id="access-code" type="password" value={token} onChange={(e) => setT(e.target.value)} autoFocus required />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn" type="submit">Sign in</button>
        {/* Demo hint only on a local machine, never on the live site. */}
        {['localhost', '127.0.0.1'].includes(location.hostname) && (
          <p className="faint small" style={{ margin: 0 }}>Running the demo locally? The code is dev-token.</p>
        )}
      </form>
    </div>
  );
}

/* ---------- pipeline board ---------- */
const STAGE_KEY = 'daspot.boardStage';

function Board() {
  const { data, error } = useLoad(() => api<Record<string, any[]>>('/pipeline'), []);
  // Phones show one stage at a time. Remember the last one picked for this visit.
  const [picked, setPicked] = useState<string | null>(() => {
    try { return sessionStorage.getItem(STAGE_KEY); } catch { return null; }
  });
  const pick = (k: string) => {
    setPicked(k);
    try { sessionStorage.setItem(STAGE_KEY, k); } catch { /* private mode */ }
  };
  const current = picked ?? (data ? (STAGES.find((s) => (data[s.key] ?? []).length > 0)?.key ?? 'new_lead') : 'new_lead');
  const open = data ? STAGES.slice(0, 5).reduce((n, s) => n + (data[s.key]?.length ?? 0), 0) : 0;
  const openValue = data ? STAGES.slice(0, 5).reduce((n, s) => n + (data[s.key] ?? []).reduce((m, j) => m + (j.subtotal_cents || 0), 0), 0) : 0;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          {data && <p className="muted">{open} open {open === 1 ? 'job' : 'jobs'}{openValue ? `, ${money(openValue)} quoted before tax` : ''}</p>}
        </div>
        <a className="btn secondary desk-only" href="#/new">New lead</a>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {!data && !error && <p className="muted">Loading the board…</p>}
      {data && (
        <div className="stage-tabs phone-only" role="tablist" aria-label="Stage">
          {STAGES.map((s) => (
            <button key={s.key} type="button" role="tab" aria-selected={current === s.key} onClick={() => pick(s.key)}>
              <span className="tab-shade" style={{ opacity: shadeOpacity(s.shade) }} />
              {s.label}<span className="tab-count">{(data[s.key] ?? []).length}</span>
            </button>
          ))}
        </div>
      )}
      {data && (
        <div className="board">
          {STAGES.map((s) => {
            const jobs = data[s.key] ?? [];
            return (
              <section key={s.key} className={`col${current === s.key ? ' active' : ''}`} aria-label={s.label}>
                <div className="col-head">
                  <div className="shade-bar" style={{ opacity: shadeOpacity(s.shade) }} title={`${s.shade}% shade`} />
                  <div className="col-title"><h2>{s.label}</h2><span className="count">{jobs.length}</span></div>
                </div>
                <div className="col-body">
                  {jobs.length === 0 && <div className="empty-col">No jobs</div>}
                  {jobs.map((j) => <JobCard key={j.id} j={j} />)}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function JobCard({ j }: { j: any }) {
  const tags: ReactNode[] = [];
  if (j.stale) tags.push(<span key="stale" className="pill warn">No reply 3+ days</span>);
  if (j.language === 'es') tags.push(<span key="es" className="pill">Español</span>);
  const src = sourceLabel(j.lead_source);
  return (
    <a className="card" href={`#/jobs/${j.id}`}>
      <div className="card-top"><span className="who">{personName(j)}</span><span className="num">#{j.number}</span></div>
      <div className="vehicle">{vehicleName(j) || 'Vehicle not added'}</div>
      {tags.length > 0 && <div className="card-tags">{tags}</div>}
      <div className="card-meta">
        <span>{j.next_appointment ? when(j.next_appointment) : src}</span>
        {j.subtotal_cents > 0 && <span className="price">{money(j.subtotal_cents)}</span>}
      </div>
    </a>
  );
}

/* ---------- quick lead ---------- */
function QuickLead() {
  const [f, setF] = useState({ first_name: '', last_name: '', mobile: '', language: 'en', year: '', make: '', model: '', lead_source: 'text', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const hasVehicle = f.year || f.make || f.model;
      const out = await api('/leads', { body: {
        contact: { first_name: f.first_name, last_name: f.last_name, mobile: f.mobile, language: f.language },
        vehicle: hasVehicle ? { year: f.year ? Number(f.year) : null, make: f.make, model: f.model } : undefined,
        lead_source: f.lead_source, note: f.note,
      } });
      location.hash = `#/jobs/${out.job.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <p className="crumb"><a href="#/">Pipeline</a></p>
          <h1>New lead</h1>
        </div>
      </div>
      <form className="panel" onSubmit={submit}>
        <div className="panel-body form">
          <fieldset>
            <legend>Customer</legend>
            <div className="fields">
              <label>Mobile<input id="lead-mobile" type="tel" value={f.mobile} onChange={set('mobile')} inputMode="tel" autoComplete="off" required placeholder="(214) 555-0123" /></label>
              <label>First name<input id="lead-first" value={f.first_name} onChange={set('first_name')} autoCapitalize="words" autoComplete="off" /></label>
              <label>Last name<input id="lead-last" value={f.last_name} onChange={set('last_name')} autoCapitalize="words" autoComplete="off" /></label>
              <label>Language
                <select id="lead-lang" value={f.language} onChange={set('language')}><option value="en">English</option><option value="es">Español</option></select>
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Vehicle</legend>
            <div className="fields">
              <label>Year<input id="lead-year" value={f.year} onChange={set('year')} inputMode="numeric" pattern="(19|20)\d{2}" placeholder="2024" /></label>
              <label>Make<input id="lead-make" value={f.make} onChange={set('make')} placeholder="Toyota" autoCapitalize="words" autoComplete="off" /></label>
              <label>Model<input id="lead-model" value={f.model} onChange={set('model')} placeholder="Camry" autoCapitalize="words" autoComplete="off" /></label>
            </div>
          </fieldset>
          <div className="fields">
            <label>How they found us
              <select id="lead-source" value={f.lead_source} onChange={set('lead_source')}>
                {['text', 'instagram', 'tiktok', 'website', 'walk-in', 'referral', 'funnel', 'dealer'].map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
              </select>
            </label>
          </div>
          <label>Note<textarea id="lead-note" rows={3} value={f.note} onChange={set('note')} placeholder="Wants 20% all around, asked about ceramic" /></label>
          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="panel-foot actions form-actions">
          <a className="btn ghost" href="#/">Cancel</a>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Create lead'}</button>
        </div>
      </form>
    </div>
  );
}

/* ---------- job detail ---------- */
const NEXT: Record<string, { to: string; label: string }[]> = {
  new_lead: [{ to: 'quoted', label: 'Mark quoted' }],
  quoted: [{ to: 'booked', label: 'Mark booked' }, { to: 'new_lead', label: 'Back to new lead' }],
  booked: [{ to: 'in_bay', label: 'Start install' }, { to: 'quoted', label: 'Back to quoted' }],
  in_bay: [{ to: 'completed', label: 'Mark completed' }, { to: 'booked', label: 'Back to booked' }],
  completed: [{ to: 'in_bay', label: 'Reopen install' }],
  lost: [{ to: 'new_lead', label: 'Reopen lead' }],
  paid: [],
};

function StagePill({ stage, lostReason }: { stage: string; lostReason?: string | null }) {
  if (stage === 'lost') return <span className="pill bad"><span className="dot" />Lost{lostReason ? `: ${lostReason.replace('_', ' ')}` : ''}</span>;
  if (stage === 'paid') return <span className="pill good"><span className="dot" />Paid</span>;
  const s = STAGES.find((x) => x.key === stage);
  return <span className="pill accent"><span className="dot" />{s?.label ?? stage}</span>;
}

function JobPage({ id }: { id: string }) {
  const { data: job, error, setData } = useLoad(() => api(`/jobs/${id}`), [id]);
  const { data: films } = useLoad(() => api<any[]>('/film-products'), []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (path: string, body: unknown, method = 'POST') => {
    setBusy(true);
    setActionError(null);
    try {
      const out = await api(path, { method, body });
      if (out && out.id === id) setData(out); else setData(await api(`/jobs/${id}`));
      return true;
    } catch (err) {
      setActionError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="error" role="alert">{error}</div>;
  if (!job) return <p className="muted">Loading job…</p>;
  const locked = job.stage === 'paid' || job.stage === 'lost';
  const stageIndex = STAGES.findIndex((x) => x.key === job.stage);
  const [primary, ...secondary] = NEXT[job.stage] ?? [];
  const canLose = !locked && !['in_bay', 'completed'].includes(job.stage);
  const vehicle = vehicleName(job) || job.property_address;
  const src = sourceLabel(job.lead_source);

  return (
    <div className="job-page">
      <div className="job-head">
        <p className="crumb"><a href="#/">Pipeline</a> / Job #{job.number}</p>
        <div className="job-title">
          <div>
            <div className="actions" style={{ gap: 12 }}>
              <h1>{personName(job)}</h1>
              <StagePill stage={job.stage} lostReason={job.lost_reason} />
            </div>
            <div className="sub">
              <span>{vehicle || 'Vehicle not added'}</span>
              <span className="desk-only">{formatPhone(job.mobile)}</span>
              {job.language === 'es' && <span>Español</span>}
              {src && <span>From {src}</span>}
              {job.is_warranty_redo && <span>Warranty re-do, no charge</span>}
            </div>
            <div className="contact-buttons">
              <a className="btn secondary sm" href={`tel:${job.mobile}`}>Call</a>
              <a className="btn secondary sm" href={`sms:${job.mobile}`}>Text</a>
              <span className="faint small phone-only">{formatPhone(job.mobile)}</span>
            </div>
          </div>
          <div className="actions job-actions">
            {(secondary.length > 0 || canLose) && (
              <details className="more">
                <summary className="btn secondary">More</summary>
                <div className="more-menu">
                  {secondary.map((n) => (
                    <button key={n.to} className="btn secondary" disabled={busy} onClick={() => run(`/jobs/${id}/stage`, { to: n.to })}>{n.label}</button>
                  ))}
                  {canLose && <LoseForm disabled={busy} onLose={(reason) => run(`/jobs/${id}/stage`, { to: 'lost', lost_reason: reason })} />}
                </div>
              </details>
            )}
            {primary && <button className="btn" disabled={busy} onClick={() => run(`/jobs/${id}/stage`, { to: primary.to })}>{primary.label}</button>}
          </div>
        </div>
        {job.stage !== 'lost' && (
          <div aria-label={`Stage ${stageIndex + 1} of ${STAGES.length}`}>
            <div className="stepper">
              {STAGES.map((s, i) => (
                <span key={s.key} style={i <= stageIndex ? { background: 'var(--ink)', opacity: shadeOpacity(s.shade) } : undefined} />
              ))}
            </div>
            <div className="stepper-labels" aria-hidden="true">
              {STAGES.map((s, i) => <span key={s.key} className={i === stageIndex ? 'on' : undefined}>{s.label}</span>)}
            </div>
          </div>
        )}
      </div>

      {actionError && <div className="error" role="alert" style={{ marginBottom: 20 }}>{actionError}</div>}
      {job.waiver_required && !job.waiver_signed_at && !locked && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <div><strong>Front side shade is below the Texas 25% limit.</strong> The customer must sign the acknowledgment before this job can be completed.</div>
          <WaiverForm disabled={busy} onSign={(name) => run(`/jobs/${id}/waiver`, { signed_name: name })} />
        </div>
      )}

      <div className="job-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Services</h2></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Service</th><th className="desk-only">Film</th><th className="desk-only">Shade</th><th className="num">Price</th>{!locked && <th><span className="faint" style={{ position: 'absolute', left: -9999 }}>Actions</span></th>}</tr></thead>
                <tbody>
                  {job.line_items.length === 0 && <tr><td colSpan={5} className="empty">No services yet. Add what you're quoting below.</td></tr>}
                  {job.line_items.map((li: any) => (
                    <tr key={li.id}>
                      <td>
                        {SERVICES[li.service] ?? li.service}{li.qty > 1 ? ` × ${li.qty}` : ''}
                        {(li.film_line || li.shade_vlt) && (
                          <div className="faint small phone-only">{[li.film_line, li.shade_vlt ? `${li.shade_vlt}%` : null].filter(Boolean).join(', ')}</div>
                        )}
                        {li.description ? <div className="faint small">{li.description}</div> : null}
                      </td>
                      <td className="desk-only">{li.film_line ?? <span className="faint">None</span>}</td>
                      <td className="desk-only">{li.shade_vlt ? `${li.shade_vlt}%` : <span className="faint">None</span>}</td>
                      <td className="num">{money(li.qty * li.unit_price_cents)}</td>
                      {!locked && <td className="num"><button className="btn ghost sm" disabled={busy} aria-label={`Remove ${SERVICES[li.service]}`}
                        onClick={() => run(`/jobs/${id}/line-items/${li.id}`, undefined, 'DELETE')}>Remove</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!locked && <div className="panel-foot"><LineItemForm films={films ?? []} disabled={busy} onAdd={(b) => run(`/jobs/${id}/line-items`, b)} /></div>}
          </section>

          {!locked && (
            <section className="panel">
              <div className="panel-head"><h2>Appointment</h2></div>
              {job.appointments.filter((a: any) => a.status !== 'cancelled').length > 0 && (
                <div className="list">
                  {job.appointments.filter((a: any) => a.status !== 'cancelled').map((a: any) => (
                    <div key={a.id} className="list-row">
                      <div className="main">
                        <span>{when(a.starts_at)} to {new Date(a.ends_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                        <span className="faint small">Bay {a.bay}</span>
                      </div>
                      {['scheduled', 'confirmed'].includes(a.status) && (
                        <button className="btn ghost sm" disabled={busy} onClick={() => run(`/appointments/${a.id}/cancel`, {})}>Cancel</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {['new_lead', 'quoted', 'booked'].includes(job.stage) && (
                <div className="panel-foot"><AppointmentForm disabled={busy} onBook={(b) => run(`/jobs/${id}/appointments`, b)} /></div>
              )}
              {!['new_lead', 'quoted', 'booked'].includes(job.stage) && job.appointments.filter((a: any) => a.status !== 'cancelled').length === 0 && (
                <p className="empty">No appointment on file.</p>
              )}
            </section>
          )}

          {job.warranties.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>Warranties</h2></div>
              <div className="list">{job.warranties.map((w: any) => <WarrantyRow key={w.id} w={w} />)}</div>
            </section>
          )}
        </div>

        <div className="stack side">
          <section className="panel">
            <div className="panel-body">
              <div className="totals">
                <span className="label">Subtotal</span><span>{money(job.totals.subtotal_cents)}</span>
                {job.totals.discount_cents > 0 && <><span className="label">Discount</span><span>−{money(job.totals.discount_cents)}</span></>}
                <span className="label">Sales tax {(job.tax_rate_bp / 100).toFixed(2)}%</span><span>{money(job.totals.tax_cents)}</span>
                <span className="rule" />
                <span className="label">Total</span><span className="grand">{money(job.totals.total_cents)}</span>
                <span className="label">Paid</span><span>{money(job.totals.paid_cents)}</span>
              </div>
              {job.stage === 'paid' && job.totals.balance_cents > 0 ? (
                <div className="balance"><span>Refunded after payment</span><span>{money(job.totals.balance_cents)}</span></div>
              ) : (
                <div className={`balance${job.totals.balance_cents <= 0 && job.totals.total_cents > 0 ? ' zero' : ''}`}>
                  <span>Balance</span><span>{money(job.totals.balance_cents)}</span>
                </div>
              )}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Payments</h2></div>
            {job.payments.length === 0
              ? <p className="empty" style={{ margin: 0 }}>No payments yet.</p>
              : (
                <div className="list">
                  {job.payments.map((p: any) => (
                    <div key={p.id} className="list-row">
                      <div className="main">
                        <span style={{ textTransform: 'capitalize' }}>{p.kind}</span>
                        <span className="faint small">{new Date(p.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, {sourceLabel(p.method) ?? p.method}</span>
                      </div>
                      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{p.kind === 'refund' ? '−' : ''}{money(p.amount_cents)}</span>
                    </div>
                  ))}
                </div>
              )}
            {job.stage !== 'lost' && (job.totals.balance_cents > 0 || job.totals.paid_cents > 0) && (
              <div className="panel-foot">
                <PaymentForm key={`${job.totals.balance_cents}-${job.payments.length}`} balance={job.totals.balance_cents}
                  disabled={busy} onPay={(b) => run(`/jobs/${id}/payments`, b)} />
              </div>
            )}
          </section>
          {job.waiver_signed_at && (
            <p className="small muted" style={{ margin: 0 }}>
              <span className="pill good">Shade acknowledgment signed</span>{' '}
              by {job.waiver_name}, {new Date(job.waiver_signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function LoseForm({ onLose, disabled }: { onLose: (r: string) => void; disabled: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <>
      <label>Mark as lost
        <select id="lost-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Pick a reason</option>
          <option value="price">Price</option><option value="went_elsewhere">Went elsewhere</option>
          <option value="no_response">No response</option><option value="illegal_shade">Wanted illegal shade</option><option value="other">Other</option>
        </select>
      </label>
      <button className="btn danger" disabled={disabled || !reason} onClick={() => onLose(reason)}>Mark lost</button>
    </>
  );
}

function WaiverForm({ onSign, disabled }: { onSign: (n: string) => void; disabled: boolean }) {
  const [name, setName] = useState('');
  return (
    <form className="actions" onSubmit={(e) => { e.preventDefault(); onSign(name); }}>
      <input id="waiver-name" autoCapitalize="words" autoComplete="off" style={{ maxWidth: 320, flex: 1 }} aria-label="Customer's full name" placeholder="Customer types their full name"
        value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
      <button className="btn" disabled={disabled}>Record signature</button>
    </form>
  );
}

function LineItemForm({ films, onAdd, disabled }: { films: any[]; onAdd: (b: object) => Promise<boolean>; disabled: boolean }) {
  const blank = { service: 'full_tint', film_product_id: '', shade_vlt: '', price: '' };
  const [f, setF] = useState(blank);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = Math.round(Number(f.price) * 100);
    const ok = await onAdd({ service: f.service, film_product_id: f.film_product_id || null,
      shade_vlt: f.shade_vlt ? Number(f.shade_vlt) : null, unit_price_cents: cents });
    if (ok) setF(blank);
  };
  return (
    <form className="fields" onSubmit={submit}>
      <label>Service
        <select id="li-service" value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}>
          {Object.entries(SERVICES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>Film
        <select id="li-film" value={f.film_product_id} onChange={(e) => setF({ ...f, film_product_id: e.target.value })}>
          <option value="">None</option>
          {films.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.line}</option>)}
        </select>
      </label>
      <label>Shade
        <select id="li-shade" value={f.shade_vlt} onChange={(e) => setF({ ...f, shade_vlt: e.target.value })}>
          <option value="">None</option>
          {[80, 70, 50, 40, 35, 20, 15, 5].map((s) => <option key={s} value={s}>{s}%</option>)}
        </select>
      </label>
      <label>Price ($)<input id="li-price" type="text" enterKeyHint="done" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" required pattern="\d+(\.\d{1,2})?" placeholder="0.00" /></label>
      <button className="btn secondary" disabled={disabled}>Add service</button>
    </form>
  );
}

function AppointmentForm({ onBook, disabled }: { onBook: (b: object) => Promise<boolean>; disabled: boolean }) {
  const [f, setF] = useState({ date: '', time: '10:00', hours: '2', bay: '1' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Built from the device's local time, then sent as an ISO instant.
    const start = new Date(`${f.date}T${f.time}`);
    const end = new Date(start.getTime() + Number(f.hours) * 3600_000);
    await onBook({ starts_at: start.toISOString(), ends_at: end.toISOString(), bay: Number(f.bay) });
  };
  return (
    <form className="fields" onSubmit={submit}>
      <label>Date<input id="appt-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
      <label>Start<input id="appt-time" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /></label>
      <label>Hours
        <select id="appt-hours" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })}>{['1', '1.5', '2', '3', '4', '6', '8'].map((h) => <option key={h}>{h}</option>)}</select>
      </label>
      <label>Bay<select id="appt-bay" value={f.bay} onChange={(e) => setF({ ...f, bay: e.target.value })}>{['1', '2', '3'].map((b) => <option key={b}>{b}</option>)}</select></label>
      <button className="btn secondary" disabled={disabled}>Book</button>
    </form>
  );
}

function PaymentForm({ balance, onPay, disabled }: { balance: number; onPay: (b: object) => Promise<boolean>; disabled: boolean }) {
  // Starts prefilled with the balance; the parent remounts this form (key) whenever the balance changes.
  const [f, setF] = useState(() => ({ amount: balance > 0 ? (balance / 100).toFixed(2) : '', kind: balance > 0 ? 'balance' : 'refund', method: 'card' }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onPay({ amount_cents: Math.round(Number(f.amount) * 100), kind: f.kind, method: f.method });
  };
  return (
    <form className="form" style={{ gap: 12 }} onSubmit={submit}>
      <label>Amount ($)<input id="pay-amount" type="text" enterKeyHint="done" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" required pattern="\d+(\.\d{1,2})?" /></label>
      <div className="fields">
        <label>Type
          <select id="pay-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="balance">Payment</option><option value="deposit">Deposit</option><option value="refund">Refund</option>
          </select>
        </label>
        <label>Method
          <select id="pay-method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {[['card', 'Card'], ['cash', 'Cash'], ['zelle', 'Zelle'], ['affirm', 'Affirm'], ['afterpay', 'Afterpay'], ['terms', 'Net terms']].map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <button className="btn" disabled={disabled}>{f.kind === 'refund' ? 'Record refund' : 'Record payment'}</button>
    </form>
  );
}

function WarrantyRow({ w, showCustomer = false }: { w: any; showCustomer?: boolean }) {
  const status = w.status === 'voided' ? <span className="pill bad">Voided</span>
    : w.in_term === false ? <span className="pill warn">Expired</span>
    : <span className="pill good">Active</span>;
  return (
    <div className="list-row">
      <div className="main">
        <span className="warranty-num">{w.number}</span>
        <span>{w.coverage === 'labor' ? 'Shop labor' : `${w.film_brand} ${w.film_line}`}, {w.expires_on ? `until ${w.expires_on}` : 'lifetime'}</span>
        {showCustomer && (
          <span className="faint small">
            {[personName(w), formatPhone(w.mobile), w.email, vehicleName(w), w.plate ? `plate ${w.plate}` : null,
              w.claim_count ? `${w.claim_count} claim${w.claim_count === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')}
          </span>
        )}
      </div>
      {status}
    </div>
  );
}

/* ---------- warranty lookup ---------- */
function WarrantyLookup() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try { setResults(await api(`/warranties/lookup?q=${encodeURIComponent(q)}`)); }
    catch (err) { setError((err as Error).message); setResults(null); }
  };
  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1>Warranties</h1>
          <p className="muted">Find a customer's coverage by name, phone, email, plate, VIN or warranty number.</p>
        </div>
      </div>
      <form className="panel panel-body actions" onSubmit={search} style={{ alignItems: 'end' }}>
        <label style={{ flex: 1, minWidth: 220 }}>Name, phone, email, plate, VIN or warranty number
          <input id="warranty-q" type="search" enterKeyHint="search" autoCapitalize="off" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
            placeholder="Sofia Ramirez, (214) 555-0123, or DS-1042-M1" required minLength={3} />
        </label>
        <button className="btn">Search</button>
      </form>
      {error && <div className="error" role="alert" style={{ marginTop: 16 }}>{error}</div>}
      {results && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head"><h2>{results.length} {results.length === 1 ? 'result' : 'results'}</h2></div>
          {results.length === 0 && <p className="empty" style={{ margin: 0 }}>No warranty matches "{q}". Check the spelling, or try their phone number. Email searches need the full address.</p>}
          <div className="list">
            {results.map((w) => <a key={w.id} href={`#/jobs/${w.job_id}`} style={{ color: 'inherit', textDecoration: 'none' }}><WarrantyRow w={w} showCustomer /></a>)}
          </div>
        </section>
      )}
    </div>
  );
}
