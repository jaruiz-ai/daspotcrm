import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { addMonths, detectDateOrder, parseDay, parseTerm } from '../src/lib/csv.js';
import { guessMapping } from '../src/lib/importClients.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

describe('reading dates from a spreadsheet', () => {
  it.each([
    ['3/15/2025', '2025-03-15'], ['03/15/2025', '2025-03-15'], ['3/15/25', '2025-03-15'],
    ['3-15-2025', '2025-03-15'], ['3.15.2025', '2025-03-15'], ['2025-03-15', '2025-03-15'],
    ['2025/3/15', '2025-03-15'], ['March 15, 2025', '2025-03-15'], ['Mar 15 2025', '2025-03-15'],
    ['Mar. 15th, 2025', '2025-03-15'], ['Sept 3, 2024', '2024-09-03'], ['15 March 2025', '2025-03-15'],
    ['15-Mar-2025', '2025-03-15'], ['15 de marzo de 2025', '2025-03-15'], ['3 de septiembre del 2024', '2024-09-03'],
    ['45731', '2025-03-15'], ['3/15/2025 2:30 PM', '2025-03-15'], ['2025-03-15T23:59:00Z', '2025-03-15'],
    ['2/29/2024', '2024-02-29'], ['12/31/99', '1999-12-31'],
  ])('%s → %s', (raw, want) => {
    expect(parseDay(raw)).toBe(want);
  });

  it.each(['2/29/2023', '2/30/2024', '13/45/2024', '00/10/2024', 'next week', '', 'Lifetime', '1/1/1970'])('rejects %j', (raw) => {
    expect(parseDay(raw)).toBeNull();
  });

  it('reads numeric dates day-first when told to', () => {
    expect(parseDay('04/05/2024', 'mdy')).toBe('2024-04-05');
    expect(parseDay('04/05/2024', 'dmy')).toBe('2024-05-04');
    expect(parseDay('15/03/2025', 'dmy')).toBe('2025-03-15');
    expect(parseDay('15/03/2025', 'mdy')).toBeNull(); // never silently swapped
  });

  it('works out day/month order from the whole column', () => {
    expect(detectDateOrder(['15/03/2025', '04/05/2024'])).toMatchObject({ order: 'dmy', conflicting: false });
    expect(detectDateOrder(['03/15/2025', '04/05/2024'])).toMatchObject({ order: 'mdy', conflicting: false });
    expect(detectDateOrder(['04/05/2024', '01/02/2023', '07/07/2022'])).toEqual({ order: 'mdy', ambiguous: 2, conflicting: false });
    expect(detectDateOrder(['15/03/2025', '03/16/2025']).conflicting).toBe(true);
  });

  it.each([
    ['Lifetime', null], ['lifetime warranty', null], ['De por vida', null], ['5 years', 60], ['5 yrs', 60],
    ['10 Years', 120], ['24 months', 24], ['18 mo', 18], ['5 años', 60], ['6 meses', 6], ['5', 60], ['36', 36],
  ])('warranty length %j → %j months', (raw, months) => {
    expect(parseTerm(raw)?.months).toBe(months);
  });
});

describe('warranty end dates at month ends and leap days', () => {
  it.each([
    ['2024-01-31', 1, '2024-02-29'], ['2023-01-31', 1, '2023-02-28'], ['2024-02-29', 60, '2029-02-28'],
    ['2024-02-29', 48, '2028-02-29'], ['2024-12-15', 1, '2025-01-15'], ['2025-03-31', 6, '2025-09-30'],
    ['2025-03-15', 0, '2025-03-15'], ['2020-08-31', 120, '2030-08-31'],
  ])('%s + %i months = %s', (day, months, want) => {
    expect(addMonths(day as string, months as number)).toBe(want);
  });

  it('agrees with Postgres for 400 dates, including every month end, so preview and saved dates never differ', async () => {
    const days: string[] = [];
    for (let y = 2019; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (const d of [1, 15, 28, last]) days.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    const terms = [1, 6, 12, 13, 24, 36, 60, 120];
    const pairs = days.slice(0, 400).map((d, i) => [d, terms[i % terms.length]] as const);
    const { rows } = await ctx.db.query(
      `SELECT d::text AS day, n, ((d::date + make_interval(months => n))::date)::text AS pg
         FROM unnest($1::date[], $2::int[]) AS t(d, n)`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])]);
    for (const r of rows) expect(addMonths(r.day, r.n)).toBe(r.pg);
  });
});

describe('importing past clients keeps every warranty date exact', () => {
  const sheet = [
    'Customer Name,Phone #,Email,Vehicle,Plate,Install Date,Film,Tint %,Warranty #,Warranty Expires,Notes',
    'Sofia Ramirez,(972) 555-0192,Sofia@Gmail.com,2023 Lexus RX 350,RHT 2290,3/15/2025,Nano Ceramic,35%,W-1001,Lifetime,VIP',
    '"Ortega, Luis",972.555.0134,,2020 Chevy Tahoe,,"January 31, 2024",XPEL Prime XR,20,W-1002,01/31/2029,',
    'Mark Lee,214-555-0111,,2019 Honda Civic,,2/29/2024,Carbon,35,,,',
    'Dana Cole,2145550122,,,,"Oct 3rd, 2022",Mystery Film,,W-1004,,',
    'Ray Diaz,2145550133,,,,12/01/2023,Carbon,,W-1005,11/30/2023,',
    'Kim Park,2145550144,,,,45731,Nano Ceramic,,,,',
    'No Phone,,,,,1/1/2024,Carbon,,,,',
    'Fut Ure,2145550155,,,,1/1/2099,Carbon,,,,',
  ].join('\n');

  it('maps the columns of a typical Google Sheet', () => {
    const headers = sheet.split('\n')[0].split(',');
    const m = guessMapping(headers);
    expect(m).toMatchObject({ full_name: 0, phone: 1, email: 2, vehicle: 3, plate: 4, install_date: 5, film: 6,
      shade: 7, warranty_number: 8, warranty_expires: 9, notes: 10 });
  });

  let preview: any;
  it('previews each warranty start and end without saving anything', async () => {
    const r = await ctx.api.post('/api/import/clients', { csv: sheet, dry_run: true });
    expect(r.status).toBe(200);
    preview = r.body;
    expect(preview.date_order).toMatchObject({ order: 'mdy', conflicting: false });
    const row = (name: string) => preview.rows.find((x: any) => x.name === name);

    expect(row('Sofia Ramirez').warranties).toEqual([expect.objectContaining(
      { number: 'W-1001', starts_on: '2025-03-15', expires_on: null, source: 'sheet', in_term: true })]);
    expect(row('Luis Ortega').warranties).toEqual([expect.objectContaining(
      { number: 'W-1002', film_line: 'XPEL Prime XR', starts_on: '2024-01-31', expires_on: '2029-01-31', source: 'sheet' })]);
    // Leap day + 5-year film term lands on Feb 28; 12-month labor term already expired.
    expect(row('Mark Lee').warranties).toEqual([
      expect.objectContaining({ coverage: 'manufacturer', starts_on: '2024-02-29', expires_on: '2029-02-28', source: 'film', in_term: true }),
      expect.objectContaining({ coverage: 'labor', starts_on: '2024-02-29', expires_on: '2025-02-28', in_term: false }),
    ]);
    expect(row('Dana Cole').warranties).toEqual([]);
    expect(row('Dana Cole').notes.join(' ')).toMatch(/no end date, length or known film/);
    expect(row('Ray Diaz').warranties).toEqual([]);
    expect(row('Ray Diaz').notes.join(' ')).toMatch(/before the install date/);
    expect(row('Kim Park').install_date).toBe('2025-03-15'); // spreadsheet serial number
    expect(row('No Phone').status).toBe('skipped');
    expect(row('Fut Ure').install_date).toBeNull();

    const nothing = await ctx.db.query(`SELECT COUNT(*)::int AS n FROM contacts WHERE lead_source = 'import'`);
    expect(nothing.rows[0].n).toBe(0);
  });

  it('saves exactly the dates the preview showed', async () => {
    const r = await ctx.api.post('/api/import/clients', { csv: sheet, dry_run: false });
    expect(r.status).toBe(200);
    const saved = await ctx.db.query(
      `SELECT c.first_name, c.last_name, w.number, w.coverage, w.starts_on, w.expires_on
         FROM warranties w JOIN contacts c ON c.id = w.contact_id WHERE c.lead_source = 'import'`);
    const fromPreview = preview.rows.flatMap((row: any) => row.warranties.map((w: any) => `${row.name}|${w.coverage}|${w.starts_on}|${w.expires_on}`)).sort();
    const fromDb = saved.rows.map((w: any) => `${[w.first_name, w.last_name].filter(Boolean).join(' ')}|${w.coverage}|${w.starts_on}|${w.expires_on}`).sort();
    expect(fromDb).toEqual(fromPreview);
    expect(saved.rows.map((w: any) => w.number)).toEqual(expect.arrayContaining(['W-1001', 'W-1002']));
  });

  it('finds imported warranties by their old number with the right status', async () => {
    const lookup = (await ctx.api.get('/api/warranties/lookup?q=w-1001')).body;
    expect(lookup).toHaveLength(1);
    expect(lookup[0]).toMatchObject({ first_name: 'Sofia', starts_on: '2025-03-15', expires_on: null, in_term: true });
    const mark = (await ctx.api.get('/api/warranties/lookup?q=Mark%20Lee')).body;
    expect(mark.find((w: any) => w.coverage === 'labor')).toMatchObject({ expires_on: '2025-02-28', in_term: false });
  });

  it('keeps imported jobs off the board and does not duplicate on a second import', async () => {
    const board = (await ctx.api.get('/api/pipeline')).body;
    expect(board.paid.filter((j: any) => j.lead_source === 'import')).toEqual([]);
    const before = (await ctx.db.query('SELECT COUNT(*)::int AS n FROM warranties')).rows[0].n;
    const again = (await ctx.api.post('/api/import/clients', { csv: sheet, dry_run: false })).body;
    expect(again.counts.past_jobs).toBe(0);
    expect((await ctx.db.query('SELECT COUNT(*)::int AS n FROM warranties')).rows[0].n).toBe(before);
  });

  it('gives a new number when a sheet number is already used', async () => {
    const csv = 'Name,Phone,Install Date,Film,Warranty #,Warranty Term\nTom Ng,2145550166,5/5/2024,Carbon,W-1001,5 years';
    const r = (await ctx.api.post('/api/import/clients', { csv, dry_run: false })).body;
    const w = r.rows[0].warranties[0];
    expect(w).toMatchObject({ starts_on: '2024-05-05', expires_on: '2029-05-05' });
    expect(w.number).toMatch(/^DS-\d+-M1$/);
    expect(r.rows[0].notes.join(' ')).toMatch(/W-1001 is already used/);
  });

  it('reads a day-first sheet day-first, and lets you override an ambiguous one', async () => {
    const dmy = 'Name,Phone,Date,Film\nA One,2145550171,15/03/2025,Carbon\nB Two,2145550172,04/05/2024,Carbon';
    const p = (await ctx.api.post('/api/import/clients', { csv: dmy, dry_run: true })).body;
    expect(p.date_order.order).toBe('dmy');
    expect(p.rows.map((x: any) => x.install_date)).toEqual(['2025-03-15', '2024-05-04']);

    const ambiguous = 'Name,Phone,Date,Film\nC Three,2145550173,04/05/2024,Carbon';
    const a = (await ctx.api.post('/api/import/clients', { csv: ambiguous, dry_run: true })).body;
    expect(a.date_order).toMatchObject({ order: 'mdy', ambiguous: 1 });
    expect(a.rows[0].install_date).toBe('2024-04-05');
    const forced = (await ctx.api.post('/api/import/clients', { csv: ambiguous, dry_run: true, date_order: 'dmy' })).body;
    expect(forced.rows[0].install_date).toBe('2024-05-04');
  });
});
