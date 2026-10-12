import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, getToken, setToken, money, STAGES, SERVICES, vehicleName, personName, formatPhone } from './api';

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

/** Darkness of a film shade: 70% VLT lets 70% of light through, so 30% dark. */
const shadeStyle = (vlt: number, part: 'head' | 'body') => {
  const dark = 1 - vlt / 100;
  const a = part === 'head' ? dark : dark * 0.28;
  return {
    background: `rgba(28, 35, 38, ${a.toFixed(2)})`,
    color: part === 'head' && dark > 0.45 ? '#eef3f4' : '#1c2326',
  };
};

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const route = useRoute();
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  let page: ReactNode;
  const jobMatch = route.match(/^\/jobs\/([0-9a-f-]{36})$/);
  if (jobMatch) page = <JobPage id={jobMatch[1]} />;
  else if (route === '/new') page = <QuickLead />;
  else if (route === '/warranty') page = <WarrantyLookup />;
  else page = <Board />;

  const nav = [['#/', 'Board'], ['#/new', 'New lead'], ['#/warranty', 'Warranty lookup']];
  return (
    <>
      <header className="topbar">
        <div className="brand">Da Spot 214 <span>CRM</span></div>
        <nav className="nav" aria-label="Main">
          {nav.map(([href, label]) => (
            <a key={href} href={href} aria-current={(`#${route}` === href || (href === '#/' && route.startsWith('/jobs'))) ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
      </header>
      <main>{page}</main>
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
        <h1>Da Spot 214 CRM</h1>
        <label>Shop access code
          <input type="password" value={token} onChange={(e) => setT(e.target.value)} autoFocus required />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn" type="submit">Sign in</button>
        <p className="muted small">Running the demo locally? The code is <code>dev-token</code>.</p>
      </form>
    </div>
  );
}

/* ---------- pipeline board ---------- */
function Board() {
  const { data, error } = useLoad(() => api<Record<string, any[]>>('/pipeline'), []);
  const open = data ? STAGES.slice(0, 5).reduce((n, s) => n + (data[s.key]?.length ?? 0), 0) : 0;
  return (
    <>
      <div className="page-head">
        <h1>Pipeline</h1>
        <div className="actions">
          {data && <span className="muted">{open} open {open === 1 ? 'job' : 'jobs'}</span>}
          <a className="btn" href="#/new">New lead</a>
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {!data && !error && <p className="muted">Loading the board…</p>}
      {data && (
        <div className="board">
          {STAGES.map((s) => (
            <section key={s.key} className="col" aria-label={s.label}>
              <div className="col-head" style={shadeStyle(s.shade, 'head')}>
                <span>{s.label} <span className="shade">({data[s.key]?.length ?? 0})</span></span>
                <span className="shade">{s.shade}%</span>
              </div>
              <div className="col-body" style={shadeStyle(s.shade, 'body')}>
                {(data[s.key] ?? []).length === 0 && <div className="empty-col">Nothing here</div>}
                {(data[s.key] ?? []).map((j) => (
                  <a key={j.id} className="card" href={`#/jobs/${j.id}`}>
                    <div className="row"><span>#{j.number}</span>{j.stale && <span className="flag">Quote waiting 3+ days</span>}</div>
                    <div className="who">{personName(j)}</div>
                    <div className="row"><span>{vehicleName(j) || 'No vehicle yet'}</span><span>{j.subtotal_cents ? money(j.subtotal_cents) : ''}</span></div>
                    {j.next_appointment && (
                      <div className="row"><span>{new Date(j.next_appointment).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
                    )}
                    {j.lead_source && <div className="row"><span>via {j.lead_source}</span>{j.language === 'es' && <span>Español</span>}</div>}
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
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
    <>
      <div className="page-head"><h1>New lead</h1></div>
      <form className="panel form" onSubmit={submit}>
        <fieldset>
          <legend>Customer</legend>
          <div className="fields">
            <label>Mobile<input value={f.mobile} onChange={set('mobile')} inputMode="tel" autoComplete="off" required placeholder="(214) 555-0123" /></label>
            <label>First name<input value={f.first_name} onChange={set('first_name')} /></label>
            <label>Last name<input value={f.last_name} onChange={set('last_name')} /></label>
            <label>Language
              <select value={f.language} onChange={set('language')}><option value="en">English</option><option value="es">Español</option></select>
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Vehicle</legend>
          <div className="fields">
            <label>Year<input value={f.year} onChange={set('year')} inputMode="numeric" pattern="(19|20)\d{2}" placeholder="2024" /></label>
            <label>Make<input value={f.make} onChange={set('make')} placeholder="Toyota" /></label>
            <label>Model<input value={f.model} onChange={set('model')} placeholder="Camry" /></label>
          </div>
        </fieldset>
        <div className="fields">
          <label>How they found us
            <select value={f.lead_source} onChange={set('lead_source')}>
              {['text', 'instagram', 'tiktok', 'website', 'walk-in', 'referral', 'funnel', 'dealer'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <label>Note<textarea rows={3} value={f.note} onChange={set('note')} placeholder="Wants 20% all around, asked about ceramic" /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="actions"><button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Create lead'}</button></div>
      </form>
    </>
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
  const stage = STAGES.find((s) => s.key === job.stage);
  const locked = job.stage === 'paid' || job.stage === 'lost';

  return (
    <>
      <div className="page-head">
        <div>
          <p className="muted small"><a href="#/">Pipeline</a> / Job #{job.number}</p>
          <h1>{personName(job)} · {vehicleName(job) || job.property_address || 'No vehicle yet'}</h1>
          <p className="muted">
            <a href={`sms:${job.mobile}`}>{formatPhone(job.mobile)}</a>
            {job.language === 'es' ? ' · Español' : ''}{job.lead_source ? ` · via ${job.lead_source}` : ''}
            {job.is_warranty_redo ? ' · Warranty re-do, no charge' : ''}
          </p>
          <div className="meter" aria-label={`Stage: ${stage?.label ?? 'Lost'}`}>
            {STAGES.map((s) => (
              <span key={s.key} title={s.label} style={{ background: STAGES.indexOf(s) <= STAGES.findIndex((x) => x.key === job.stage)
                ? `rgba(28,35,38,${(1 - s.shade / 100).toFixed(2)})` : 'var(--rule)' }} />
            ))}
          </div>
        </div>
        <div className="actions">
          <strong style={{ alignSelf: 'center' }}>{stage?.label ?? `Lost (${job.lost_reason?.replace('_', ' ')})`}</strong>
          {(NEXT[job.stage] ?? []).map((n) => (
            <button key={n.to} className={n.to === NEXT[job.stage][0].to ? 'btn' : 'btn quiet'} disabled={busy}
              onClick={() => run(`/jobs/${id}/stage`, { to: n.to })}>{n.label}</button>
          ))}
          {!locked && job.stage !== 'completed' && job.stage !== 'in_bay' && (
            <LoseButton disabled={busy} onLose={(reason) => run(`/jobs/${id}/stage`, { to: 'lost', lost_reason: reason })} />
          )}
        </div>
      </div>

      {actionError && <div className="error" role="alert" style={{ marginBottom: 16 }}>{actionError}</div>}
      {job.waiver_required && !job.waiver_signed_at && !locked && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Front side shade is below the Texas 25% limit.</strong> The customer must sign the acknowledgment before this job can be completed.
          <WaiverForm disabled={busy} onSign={(name) => run(`/jobs/${id}/waiver`, { signed_name: name })} />
        </div>
      )}

      <div className="job-grid">
        <div className="stack">
          <section className="panel">
            <h2>Services</h2>
            <table>
              <thead><tr><th>Service</th><th>Film</th><th>Shade</th><th className="num">Price</th><th></th></tr></thead>
              <tbody>
                {job.line_items.length === 0 && <tr><td colSpan={5} className="muted">Add the services you're quoting.</td></tr>}
                {job.line_items.map((li: any) => (
                  <tr key={li.id}>
                    <td>{SERVICES[li.service] ?? li.service}{li.qty > 1 ? ` × ${li.qty}` : ''}{li.description ? <div className="muted small">{li.description}</div> : null}</td>
                    <td>{li.film_line ?? '—'}</td>
                    <td>{li.shade_vlt ? `${li.shade_vlt}%` : '—'}</td>
                    <td className="num">{money(li.qty * li.unit_price_cents)}</td>
                    <td className="num">{!locked && <button className="btn quiet" disabled={busy} aria-label={`Remove ${SERVICES[li.service]}`}
                      onClick={() => run(`/jobs/${id}/line-items/${li.id}`, undefined, 'DELETE')}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!locked && <LineItemForm films={films ?? []} disabled={busy} onAdd={(b) => run(`/jobs/${id}/line-items`, b)} />}
          </section>

          {!locked && (
            <section className="panel">
              <h2>Appointment</h2>
              {job.appointments.filter((a: any) => a.status !== 'cancelled').map((a: any) => (
                <p key={a.id}>
                  {new Date(a.starts_at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {' – '}{new Date(a.ends_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · Bay {a.bay}{' '}
                  {['scheduled', 'confirmed'].includes(a.status) && (
                    <button className="btn quiet" disabled={busy} onClick={() => run(`/appointments/${a.id}/cancel`, {})}>Cancel</button>
                  )}
                </p>
              ))}
              {['new_lead', 'quoted', 'booked'].includes(job.stage) && <AppointmentForm disabled={busy} onBook={(b) => run(`/jobs/${id}/appointments`, b)} />}
            </section>
          )}

          {job.warranties.length > 0 && (
            <section className="panel">
              <h2>Warranties</h2>
              <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                {job.warranties.map((w: any) => <WarrantyRow key={w.id} w={w} />)}
              </div>
            </section>
          )}
        </div>

        <div className="stack">
          <section className="panel">
            <h2>Total</h2>
            <div className="totals" style={{ marginTop: 8 }}>
              <span>Subtotal</span><span>{money(job.totals.subtotal_cents)}</span>
              {job.totals.discount_cents > 0 && <><span>Discount</span><span>−{money(job.totals.discount_cents)}</span></>}
              <span>Sales tax ({(job.tax_rate_bp / 100).toFixed(2)}%)</span><span>{money(job.totals.tax_cents)}</span>
              <span className="grand">Total</span><span className="grand">{money(job.totals.total_cents)}</span>
              <span>Paid</span><span>{money(job.totals.paid_cents)}</span>
              <strong>Balance</strong><strong>{money(job.totals.balance_cents)}</strong>
            </div>
          </section>
          <section className="panel">
            <h2>Payments</h2>
            {job.payments.length === 0 && <p className="muted">No payments yet.</p>}
            {job.payments.map((p: any) => (
              <p key={p.id} className="small">{new Date(p.paid_at).toLocaleDateString()} · {p.kind} · {p.method} · <strong>{p.kind === 'refund' ? '−' : ''}{money(p.amount_cents)}</strong></p>
            ))}
            {job.stage !== 'lost' && <PaymentForm key={`${job.totals.balance_cents}-${job.payments.length}`} balance={job.totals.balance_cents} paid={job.totals.paid_cents} disabled={busy}
              onPay={(b) => run(`/jobs/${id}/payments`, b)} />}
          </section>
          {job.waiver_signed_at && (
            <section className="panel small"><span className="ok">Shade acknowledgment signed</span> by {job.waiver_name} on {new Date(job.waiver_signed_at).toLocaleDateString()}</section>
          )}
        </div>
      </div>
    </>
  );
}

function LoseButton({ onLose, disabled }: { onLose: (r: string) => void; disabled: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <span className="actions">
      <select aria-label="Reason lost" value={reason} onChange={(e) => setReason(e.target.value)}>
        <option value="">Lost because…</option>
        <option value="price">Price</option><option value="went_elsewhere">Went elsewhere</option>
        <option value="no_response">No response</option><option value="illegal_shade">Wanted illegal shade</option><option value="other">Other</option>
      </select>
      <button className="btn danger" disabled={disabled || !reason} onClick={() => onLose(reason)}>Mark lost</button>
    </span>
  );
}

function WaiverForm({ onSign, disabled }: { onSign: (n: string) => void; disabled: boolean }) {
  const [name, setName] = useState('');
  return (
    <form className="actions" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); onSign(name); }}>
      <input aria-label="Customer's full name" placeholder="Customer types their full name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
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
    <form className="fields" style={{ marginTop: 12, alignItems: 'end' }} onSubmit={submit}>
      <label>Service
        <select value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}>
          {Object.entries(SERVICES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>Film
        <select value={f.film_product_id} onChange={(e) => setF({ ...f, film_product_id: e.target.value })}>
          <option value="">None</option>
          {films.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.line}</option>)}
        </select>
      </label>
      <label>Shade
        <select value={f.shade_vlt} onChange={(e) => setF({ ...f, shade_vlt: e.target.value })}>
          <option value="">—</option>
          {[80, 70, 50, 40, 35, 20, 15, 5].map((s) => <option key={s} value={s}>{s}%</option>)}
        </select>
      </label>
      <label>Price ($)<input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" required pattern="\d+(\.\d{1,2})?" /></label>
      <button className="btn" disabled={disabled}>Add service</button>
    </form>
  );
}

function AppointmentForm({ onBook, disabled }: { onBook: (b: object) => Promise<boolean>; disabled: boolean }) {
  const [f, setF] = useState({ date: '', time: '10:00', hours: '2', bay: '1' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Built from the browser's local time, then sent as an ISO instant.
    const start = new Date(`${f.date}T${f.time}`);
    const end = new Date(start.getTime() + Number(f.hours) * 3600_000);
    await onBook({ starts_at: start.toISOString(), ends_at: end.toISOString(), bay: Number(f.bay) });
  };
  return (
    <form className="fields" style={{ marginTop: 8, alignItems: 'end' }} onSubmit={submit}>
      <label>Date<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
      <label>Start<input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /></label>
      <label>Hours
        <select value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })}>{['1', '1.5', '2', '3', '4', '6', '8'].map((h) => <option key={h}>{h}</option>)}</select>
      </label>
      <label>Bay<select value={f.bay} onChange={(e) => setF({ ...f, bay: e.target.value })}>{['1', '2', '3'].map((b) => <option key={b}>{b}</option>)}</select></label>
      <button className="btn" disabled={disabled}>Book</button>
    </form>
  );
}

function PaymentForm({ balance, paid, onPay, disabled }: { balance: number; paid: number; onPay: (b: object) => Promise<boolean>; disabled: boolean }) {
  // Starts prefilled with the balance; the parent remounts this form (key) whenever the balance changes.
  const [f, setF] = useState(() => ({ amount: balance > 0 ? (balance / 100).toFixed(2) : '', kind: 'balance', method: 'card' }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onPay({ amount_cents: Math.round(Number(f.amount) * 100), kind: f.kind, method: f.method });
  };
  if (balance <= 0 && paid <= 0) return null;
  return (
    <form className="form" style={{ marginTop: 8 }} onSubmit={submit}>
      <div className="fields">
        <label>Amount ($)<input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" required pattern="\d+(\.\d{1,2})?" /></label>
        <label>Type
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="balance">Payment</option><option value="deposit">Deposit</option><option value="refund">Refund</option>
          </select>
        </label>
        <label>Method
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {[['card', 'Card'], ['cash', 'Cash'], ['zelle', 'Zelle'], ['affirm', 'Affirm'], ['afterpay', 'Afterpay'], ['terms', 'Net terms']].map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <button className="btn" disabled={disabled}>{f.kind === 'refund' ? 'Record refund' : 'Record payment'}</button>
    </form>
  );
}

function WarrantyRow({ w }: { w: any }) {
  return (
    <div className="warranty">
      <div className="row" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="num">{w.number}</span>
        <span>{w.status === 'voided' ? <span className="flag">Voided</span> : w.in_term === false ? <span className="flag">Expired</span> : <span className="ok">Active</span>}</span>
      </div>
      <div>{w.coverage === 'labor' ? 'Shop labor' : `${w.film_brand} ${w.film_line}`} · {w.expires_on ? `${w.starts_on} to ${w.expires_on}` : `Lifetime from ${w.starts_on}`}</div>
      {w.first_name !== undefined && <div className="muted small">{personName(w)} · {vehicleName(w)}{w.plate ? ` · ${w.plate}` : ''}{w.claim_count ? ` · ${w.claim_count} claim(s)` : ''}</div>}
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
    <>
      <div className="page-head"><h1>Warranty lookup</h1></div>
      <form className="panel actions" onSubmit={search} style={{ alignItems: 'end' }}>
        <label style={{ flex: 1, minWidth: 220 }}>Phone, plate, VIN or warranty number
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="(214) 555-0123 or DS-1042-M1" required minLength={3} />
        </label>
        <button className="btn">Search</button>
      </form>
      {error && <div className="error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
      {results && (
        <div className="stack" style={{ marginTop: 16, gap: 8 }}>
          {results.length === 0 && <p className="muted">No warranty matches "{q}". Check the plate for typos, or search by the customer's phone.</p>}
          {results.map((w) => <a key={w.id} href={`#/jobs/${w.job_id}`} style={{ textDecoration: 'none', color: 'inherit' }}><WarrantyRow w={w} /></a>)}
        </div>
      )}
    </>
  );
}
