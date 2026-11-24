import { beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, setup } from './helpers.js';
import { buildConfirmation } from '../src/lib/confirmation.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup({ shopPhone: '(214) 555-0100', shopAddress: '123 Test St, Dallas, TX' }); });

/** Dallas wall-clock time on a winter day (CST, UTC-6). */
const dallas = (day: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + ((hour + 6) * 60 + minute) * 6e4).toISOString();
const slot = (day: string, hour: number, hours = 2) => ({ starts_at: dallas(day, hour), ends_at: dallas(day, hour + hours) });
const last = () => ctx.email.sent.at(-1)!;

describe('confirmation emails', () => {
  it('emails the client when they are booked, with the time in Dallas and a calendar invite', async () => {
    const before = ctx.email.sent.length;
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone(), first_name: 'Rosa', last_name: 'Delgado' }, email: 'rosa@example.com',
      vehicle: { year: 2022, make: 'Nissan', model: 'Altima' }, service: 'full_tint', price_cents: 30000,
      slot: slot('2031-01-14', 14),
    });
    expect(r.status).toBe(201);
    expect(r.body.email).toEqual({ status: 'sent', to: 'rosa@example.com', live: false });
    expect(ctx.email.sent.length).toBe(before + 1);
    const m = last();
    expect(m.to).toBe('rosa@example.com');
    expect(m.subject).toBe("You're booked: Tue, Jan 14, 2:00 PM · Da Spot 214");
    expect(m.text).toContain('Hi Rosa,');
    expect(m.text).toContain('When: Tuesday, January 14, 2:00 PM – 4:00 PM');
    expect(m.text).toContain('Vehicle: 2022 Nissan Altima');
    expect(m.text).toContain('Service: Full tint');
    expect(m.text).toContain('Where: 123 Test St, Dallas, TX');
    expect(m.text).toContain('Call or text us at (214) 555-0100');
    expect(m.html).toContain('2022 Nissan Altima');
    const ics = m.attachments![0];
    expect(ics.contentType).toBe('text/calendar');
    expect(ics.content).toContain('METHOD:PUBLISH');
    expect(ics.content).toContain('DTSTART:20310114T200000Z');
    expect(ics.content).toContain(`UID:${r.body.appointment.id}@daspot214-client`);
    // and the email is saved on the client's profile
    const job = (await ctx.api.get(`/api/jobs/${r.body.job_id}`)).body;
    expect(job.email).toBe('rosa@example.com');
  });

  it('writes to Spanish-speaking clients in Spanish', async () => {
    await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone(), first_name: 'Luis', language: 'es' }, email: 'luis@example.com',
      service: 'windshield', price_cents: 22000, slot: slot('2031-01-15', 9),
    });
    const m = last();
    expect(m.subject).toMatch(/^Cita confirmada: mié/);
    expect(m.text).toContain('Hola Luis,');
    expect(m.text).toContain('Servicio: Parabrisas');
  });

  it('emails the new time when rescheduled, and a cancellation when cancelled', async () => {
    const r = (await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone(), first_name: 'Ana' }, email: 'ana@example.com', slot: slot('2031-01-16', 10),
    })).body;
    const moved = await ctx.api.post(`/api/appointments/${r.appointment.id}/reschedule`, slot('2031-01-17', 13, 3));
    expect(moved.body.email.status).toBe('sent');
    expect(last().subject).toBe('New time: Fri, Jan 17, 1:00 PM · Da Spot 214');
    expect(last().text).toContain('Friday, January 17, 1:00 PM – 4:00 PM');
    const cancelled = await ctx.api.post(`/api/appointments/${r.appointment.id}/cancel`, {});
    expect(cancelled.body.email.status).toBe('sent');
    expect(last().subject).toBe('Appointment cancelled: Fri, Jan 17, 1:00 PM · Da Spot 214');
    expect(last().attachments![0].content).toContain('METHOD:CANCEL');
    expect(last().text).not.toContain('Where:');
  });

  it('does not email a no-show, and skips clients with no email', async () => {
    const r = (await ctx.api.post('/api/appointments', { contact: { mobile: nextPhone() }, slot: slot('2031-01-20', 9) })).body;
    expect(r.email).toEqual({ status: 'no_email' });
    const withEmail = (await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone() }, email: 'ns@example.com', slot: slot('2031-01-21', 9) })).body;
    const before = ctx.email.sent.length;
    const ns = await ctx.api.post(`/api/appointments/${withEmail.appointment.id}/cancel`, { reason: 'no_show' });
    expect(ns.body.email.status).toBe('skipped');
    expect(ctx.email.sent.length).toBe(before);
  });

  it('can book without emailing when staff say so', async () => {
    const before = ctx.email.sent.length;
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone() }, email: 'quiet@example.com', notify: false, slot: slot('2031-01-22', 9) });
    expect(r.body.email.status).toBe('skipped');
    expect(ctx.email.sent.length).toBe(before);
  });

  it('a failed email never undoes the booking; it leaves a task for the desk', async () => {
    ctx.email.failNext = true;
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone() }, email: 'bounce@example.com', slot: slot('2031-01-23', 9) });
    expect(r.status).toBe(201);
    expect(r.body.email).toEqual({ status: 'failed', to: 'bounce@example.com' });
    expect((await ctx.api.get(`/api/jobs/${r.body.job_id}`)).body.stage).toBe('booked');
    const tasks = (await ctx.api.get('/api/tasks')).body;
    expect(JSON.stringify(tasks)).toMatch(/confirmation email for job #\d+ did not go out/);
  });

  it('the job page booking sends one too', async () => {
    const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone(), email: 'jp@example.com' } })).body;
    const r = await ctx.api.post(`/api/jobs/${lead.job.id}/appointments`, slot('2031-01-24', 9));
    expect(r.body.email).toMatchObject({ status: 'sent', to: 'jp@example.com' });
  });

  it('escapes names in the HTML', () => {
    const m = buildConfirmation({ kind: 'booked', lang: 'en', firstName: '<b>Al</b>', startsAt: new Date(dallas('2031-01-14', 9)),
      endsAt: new Date(dallas('2031-01-14', 10)), vehicle: '', services: [], jobNumber: 1, appointmentId: 'x', shop: {} });
    expect(m.html).toContain('&lt;b&gt;Al&lt;/b&gt;');
    expect(m.text).toContain('Just reply to this email');
  });
});
