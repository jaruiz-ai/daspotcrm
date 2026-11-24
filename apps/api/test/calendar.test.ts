import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, setup } from './helpers.js';
import { buildIcs, feedToken } from '../src/routes/calendar.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

const dallas = (day: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + ((hour + 6) * 60 + minute) * 6e4).toISOString();
/** A day a few weeks out in January-style CST is not guaranteed, so use UTC instants directly for the feed. */
const soon = (days: number, hourUtc: number) => {
  const d = new Date(Date.now() + days * 864e5);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};
const feedPath = async (name: string) => {
  const link = (await ctx.api.get(`/api/calendar/link?name=${encodeURIComponent(name)}`)).body;
  return { link, path: new URL(link.url).pathname };
};
/** Unfold RFC 5545 continuation lines so assertions can read whole values. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

describe('calendar connection', () => {
  it('gives each person an iPhone, Google and plain link to the same private feed', async () => {
    const { link } = await feedPath('Johnathan');
    expect(link.name).toBe('Johnathan');
    expect(link.url).toMatch(/\/calendar\/johnathan-[0-9a-f]{24}\.ics$/);
    expect(link.webcal_url).toBe(link.url.replace(/^https?:/, 'webcal:'));
    expect(link.google_url).toContain(encodeURIComponent(link.webcal_url));
    const yensi = (await feedPath('Yensi')).link;
    expect(yensi.url).not.toBe(link.url);
  });

  it('needs the staff code to make a link', async () => {
    const r = await request(ctx.app).get('/api/calendar/link?name=Johnathan');
    expect(r.status).toBe(401);
  });

  it('puts a booking on the calendar the moment it is made, and takes it off when cancelled', async () => {
    const { path } = await feedPath('Johnathan');
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone(), first_name: 'Rosa', last_name: 'Delgado' },
      vehicle: { year: 2022, make: 'Nissan', model: 'Altima' },
      service: 'full_tint', price_cents: 30000, note: 'Wants 35%, coming after work',
      slot: { starts_at: soon(3, 20), ends_at: soon(3, 22), bay: 2 },
    });
    expect(r.status).toBe(201);

    // No staff code: calendar apps fetch with the link alone.
    const feed = await request(ctx.app).get(path);
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toMatch(/^text\/calendar/);
    const ics = unfold(feed.text);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain(`UID:${r.body.appointment.id}@daspot214-crm`);
    expect(ics).toContain('SUMMARY:Rosa Delgado · 2022 Nissan Altima');
    expect(ics).toContain('LOCATION:Da Spot 214');
    expect(ics).not.toMatch(/Bay \d/);
    expect(ics).toContain('Services: Full tint');
    expect(ics).toContain('Note: Wants 35%\\, coming after work');
    expect(ics).toContain(`DTSTART:${soon(3, 20).replace(/[-:]/g, '').replace('.000', '')}`);
    expect(ics).toContain('TRIGGER:-PT1H');
    expect(ics).toContain(`#/jobs/${r.body.job_id}`);

    await ctx.api.post(`/api/appointments/${r.body.appointment.id}/cancel`, {});
    const after = unfold((await request(ctx.app).get(path)).text);
    expect(after).not.toContain(`UID:${r.body.appointment.id}@daspot214-crm`);
  });

  it('drops bookings for jobs marked lost', async () => {
    const { path } = await feedPath('Yensi');
    const r = await ctx.api.post('/api/appointments', {
      contact: { mobile: nextPhone(), first_name: 'Lost' }, slot: { starts_at: soon(5, 15), ends_at: soon(5, 16), bay: 3 },
    });
    await ctx.api.post(`/api/jobs/${r.body.job_id}/stage`, { to: 'lost', lost_reason: 'price' });
    expect((await request(ctx.app).get(path)).text).not.toContain(r.body.appointment.id);
  });

  it('refuses a made-up or altered link', async () => {
    const { path } = await feedPath('Johnathan');
    expect((await request(ctx.app).get(path.replace(/[0-9a-f](?=\.ics$)/, (c) => (c === '0' ? '1' : '0')))).status).toBe(404);
    expect((await request(ctx.app).get('/calendar/johnathan.ics')).status).toBe(404);
    expect((await request(ctx.app).get(`/calendar/${feedToken('some-other-secret', 'Johnathan')}.ics`)).status).toBe(404);
  });

  it('writes valid iCalendar: escaped text and lines folded at 75 bytes', () => {
    const ics = buildIcs([{
      appointment_id: 'a1', starts_at: dallas('2031-03-04', 9), ends_at: dallas('2031-03-04', 11), bay: 1, status: 'scheduled',
      job_id: 'j1', number: 1042, stage: 'booked', first_name: 'José', last_name: 'Ñúñez; Jr.', mobile: '+12145550100',
      year: 2020, make: 'Chevrolet', model: 'Silverado 2500HD High Country', services: ['full_tint', 'windshield', 'full_tint'],
      note: 'Line one\nline two, with commas, semicolons; and a very long tail that goes on and on past seventy-five bytes',
    }], { calName: 'Da Spot 214 bookings', jobUrl: (id) => `https://crm.example/#/jobs/${id}`, now: new Date('2031-01-01T00:00:00Z') });
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const flat = unfold(ics);
    expect(flat).toContain('SUMMARY:José Ñúñez\\; Jr. · 2020 Chevrolet Silverado 2500HD High Country');
    expect(flat).toContain('Services: Full tint\\, Windshield');
    expect(flat).toContain('Note: Line one\\nline two\\, with commas\\, semicolons\\; and');
    expect(flat).toContain('DTSTART:20310304T150000Z');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
