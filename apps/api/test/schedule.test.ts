import { beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

/** Dallas wall-clock time on a day in 2031 → ISO instant (CST is UTC-6 in January). */
const dallas = (day: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + ((hour + 6) * 60 + minute) * 6e4).toISOString();
const slot = (day: string, hour: number, hours = 2, bay = 1) => ({
  starts_at: dallas(day, hour), ends_at: dallas(day, hour + hours), bay,
});

describe('Add appointment', () => {
  it('creates the client, vehicle and job, and lands it in Booked', async () => {
    const mobile = nextPhone();
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile, first_name: 'Rosa', last_name: 'Delgado', language: 'es' },
      vehicle: { year: 2022, make: 'Nissan', model: 'Altima' },
      service: 'full_tint', price_cents: 30000, note: 'Wants 35% all around',
      slot: slot('2031-01-06', 10),
    });
    expect(r.status).toBe(201);
    expect(r.body.created_job).toBe(true);
    const job = (await ctx.api.get(`/api/jobs/${r.body.job_id}`)).body;
    expect(job.stage).toBe('booked');
    expect(job.first_name).toBe('Rosa');
    expect(job.vehicle_make).toBe('Nissan');
    expect(job.line_items).toHaveLength(1);
    expect(job.totals.subtotal_cents).toBe(30000);
    expect(job.appointments).toHaveLength(1);
  });

  it('reuses a returning client by mobile and their car, filling a missing name without overwriting one', async () => {
    const mobile = nextPhone();
    const first = (await ctx.api.post('/api/leads', { contact: { mobile, first_name: 'Ana' }, vehicle: { year: 2021, make: 'Honda', model: 'Civic' } })).body;
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile, first_name: 'Someone Else', last_name: 'Gutierrez' },
      vehicle: { year: 2021, make: 'honda', model: 'civic' },
      slot: slot('2031-01-07', 9),
    });
    expect(r.status).toBe(201);
    const job = (await ctx.api.get(`/api/jobs/${r.body.job_id}`)).body;
    expect(job.contact_id).toBe(first.contact.id);
    expect(job.first_name).toBe('Ana');
    expect(job.last_name).toBe('Gutierrez');
    expect(job.vehicle_id).toBe(first.vehicle.id);
  });

  it('books an existing quote instead of starting a second job', async () => {
    const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone() } })).body;
    await ctx.api.post(`/api/jobs/${lead.job.id}/line-items`, { service: 'windshield', unit_price_cents: 22000 });
    await ctx.api.post(`/api/jobs/${lead.job.id}/stage`, { to: 'quoted' });
    const open = (await ctx.api.get(`/api/contacts/${lead.contact.id}/open-jobs`)).body;
    expect(open.map((j: any) => j.id)).toEqual([lead.job.id]);
    const r = await ctx.api.post('/api/appointments', { job_id: lead.job.id, slot: slot('2031-01-08', 13) });
    expect(r.status).toBe(201);
    expect(r.body.created_job).toBe(false);
    expect((await ctx.api.get(`/api/jobs/${lead.job.id}`)).body.stage).toBe('booked');
    expect((await ctx.api.get(`/api/contacts/${lead.contact.id}/open-jobs`)).body).toEqual([]);
  });

  it('keeps a service without a price as a note, so the job never looks paid at $0', async () => {
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone() }, service: 'wrap', slot: slot('2031-01-09', 9),
    });
    const job = (await ctx.api.get(`/api/jobs/${r.body.job_id}`)).body;
    expect(job.line_items).toHaveLength(0);
    const notes = (await ctx.api.get(`/api/notes?subject_type=job&subject_id=${job.id}`)).body;
    expect(JSON.stringify(notes)).toContain('Booked for: Wrap');
  });

  it('allows two appointments at the same time', async () => {
    await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone() }, slot: slot('2031-01-10', 10, 3) });
    const r = await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone() }, slot: slot('2031-01-10', 12, 1) });
    expect(r.status).toBe(201);
  });

  it('needs a client', async () => {
    const r = await ctx.api.post('/api/appointments', { slot: slot('2031-01-11', 9) });
    expect(r.status).toBe(400);
  });
});

describe('Today', () => {
  it('lists one Dallas day of appointments in time order, not the evening before or after', async () => {
    const day = '2031-02-03';
    const mk = (hour: number, bay: number, name: string) => ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone(), first_name: name }, slot: slot(day, hour, 1, bay),
    });
    await mk(15, 1, 'Late');
    await mk(8, 2, 'Early');
    // 11 PM the night before in Dallas is already the 3rd in UTC — must not show.
    await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone(), first_name: 'NightBefore' },
      slot: { starts_at: dallas('2031-02-02', 22), ends_at: dallas('2031-02-02', 23), bay: 3 } });
    const today = (await ctx.api.get(`/api/today?date=${day}`)).body;
    expect(today.date).toBe(day);
    expect(today.appointments.map((a: any) => a.first_name)).toEqual(['Early', 'Late']);
  });

  it('leaves out cancelled appointments', async () => {
    const r = await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone(), first_name: 'Cancels' }, slot: slot('2031-02-04', 10) });
    await ctx.api.post(`/api/appointments/${r.body.appointment.id}/cancel`, {});
    const today = (await ctx.api.get('/api/today?date=2031-02-04')).body;
    expect(today.appointments).toHaveLength(0);
  });

  it('shows what is in the bay and finished jobs still owed money', async () => {
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone(), first_name: 'Owes' }, vehicle: { make: 'BMW', model: 'M340i' }, service: 'chrome_delete', price_cents: 45000, slot: slot('2031-02-05', 9),
    });
    const moved = await ctx.api.post(`/api/jobs/${r.body.job_id}/stage`, { to: 'in_bay' });
    expect(moved.body.stage, JSON.stringify(moved.body)).toBe('in_bay');
    let today = (await ctx.api.get('/api/today')).body;
    expect(today.in_bay.map((j: any) => j.id)).toContain(r.body.job_id);
    await ctx.api.post(`/api/jobs/${r.body.job_id}/stage`, { to: 'completed' });
    today = (await ctx.api.get('/api/today')).body;
    const owed = today.to_collect.find((j: any) => j.id === r.body.job_id);
    expect(owed.balance_cents).toBe(48713);
    expect(today.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to today for a bad date', async () => {
    const r = await ctx.api.get('/api/today?date=nope');
    expect(r.status).toBe(200);
    expect(r.body.date).toBe(r.body.today);
  });
});

describe('Reschedule and cancel', () => {
  const book = async (day: string, hour: number, bay = 1, extra: object = {}) =>
    (await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone(), first_name: 'Moves' }, slot: slot(day, hour, 2, bay), ...extra })).body;

  it('moves an appointment to a new time, keeping the same appointment', async () => {
    const b = await book('2031-03-03', 9);
    const r = await ctx.api.post(`/api/appointments/${b.appointment.id}/reschedule`, slot('2031-03-05', 13, 3, 2));
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(b.appointment.id);
    expect(new Date(r.body.ends_at).toISOString()).toBe(dallas('2031-03-05', 16));
    expect(new Date(r.body.starts_at).toISOString()).toBe(dallas('2031-03-05', 13));
    const job = (await ctx.api.get(`/api/jobs/${b.job_id}`)).body;
    expect(job.stage).toBe('booked');
    expect(job.appointments).toHaveLength(1);
    const act = (await ctx.api.get(`/api/jobs/${b.job_id}/activity`)).body;
    expect(JSON.stringify(act)).toContain('appointment_rescheduled');
  });

  it('can move onto a time another car already has', async () => {
    await book('2031-03-09', 10);
    const b = await book('2031-03-09', 14);
    const r = await ctx.api.post(`/api/appointments/${b.appointment.id}/reschedule`, slot('2031-03-09', 11, 2));
    expect(r.status).toBe(200);
  });

  it('will not move a cancelled appointment or one for a car already in the bay', async () => {
    const b = await book('2031-03-10', 9, 1, { vehicle: { make: 'Kia', model: 'K5' }, service: 'windshield', price_cents: 20000 });
    const moved = await ctx.api.post(`/api/jobs/${b.job_id}/stage`, { to: 'in_bay' });
    expect(moved.body.stage, JSON.stringify(moved.body)).toBe('in_bay');
    expect((await ctx.api.post(`/api/appointments/${b.appointment.id}/reschedule`, slot('2031-03-11', 9))).status).toBe(400);
    const c = await book('2031-03-12', 9);
    await ctx.api.post(`/api/appointments/${c.appointment.id}/cancel`, {});
    const r = await ctx.api.post(`/api/appointments/${c.appointment.id}/reschedule`, slot('2031-03-13', 9));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_reschedulable');
  });

  it('cancelling the only appointment puts the job back to Quoted', async () => {
    const b = await book('2031-03-16', 10, 2);
    const r = await ctx.api.post(`/api/appointments/${b.appointment.id}/cancel`, { reason: 'client_cancelled' });
    expect(r.body.status).toBe('cancelled');
    expect((await ctx.api.get(`/api/jobs/${b.job_id}`)).body.stage).toBe('quoted');
    // and it can be booked again from Quoted
    const re = await ctx.api.post(`/api/jobs/${b.job_id}/appointments`, slot('2031-03-17', 10, 2, 2));
    expect(re.status).toBe(201);
    expect((await ctx.api.get(`/api/jobs/${b.job_id}`)).body.stage).toBe('booked');
  });

  it('records a no-show separately from a cancellation', async () => {
    const b = await book('2031-03-18', 9);
    const r = await ctx.api.post(`/api/appointments/${b.appointment.id}/cancel`, { reason: 'no_show' });
    expect(r.body.status).toBe('no_show');
    const twice = await ctx.api.post(`/api/appointments/${b.appointment.id}/cancel`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.error.message).toBe('Appointment is already no show');
  });
});

describe('7-day view', () => {
  it('groups a week of appointments by Dallas day, starting on the day asked for', async () => {
    const start = '2031-04-07';
    await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone(), first_name: 'Mon' }, slot: slot('2031-04-07', 9, 1, 1) });
    await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone(), first_name: 'Wed' }, slot: slot('2031-04-09', 15, 1, 1) });
    await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone(), first_name: 'Sun' }, slot: slot('2031-04-13', 10, 1, 1) });
    await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone(), first_name: 'NextMon' }, slot: slot('2031-04-14', 10, 1, 1) });
    const w = (await ctx.api.get(`/api/week?start=${start}`)).body;
    expect(w.start).toBe(start);
    expect(w.days.map((d: any) => d.date)).toEqual(['2031-04-07', '2031-04-08', '2031-04-09', '2031-04-10', '2031-04-11', '2031-04-12', '2031-04-13']);
    expect(w.days.map((d: any) => d.appointments.map((a: any) => a.first_name))).toEqual([['Mon'], [], ['Wed'], [], [], [], ['Sun']]);
  });

  it('crosses daylight saving without losing or doubling a day', async () => {
    // Clocks go forward in Dallas on 2031-03-09.
    const w = (await ctx.api.get('/api/week?start=2031-03-07')).body;
    expect(w.days.map((d: any) => d.date)).toEqual(['2031-03-07', '2031-03-08', '2031-03-09', '2031-03-10', '2031-03-11', '2031-03-12', '2031-03-13']);
  });
});
