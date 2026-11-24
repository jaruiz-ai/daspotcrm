import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import App from './App';
import { createApp } from '../../api/src/app';
import { createMemoryDb, migrate, type Db } from '../../api/src/db/index';
import { seed } from '../../api/src/db/seed';
import { FakeSender } from '../../api/src/lib/messaging';

// A real API server (in-memory Postgres) behind the UI, so these runs exercise the full stack.
let server: Server;
let db: Db;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  db = await createMemoryDb();
  await migrate(db);
  await seed(db);
  const app = createApp({ db, sender: new FakeSender(), config: { staffToken: 'ui-token', twilioAuthToken: '', publicBaseUrl: '' } });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(base + url, init)) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  server?.close();
  await db?.close();
});
beforeEach(() => {
  cleanup();
  localStorage.clear();
  location.hash = '#/';
});

const signIn = async (user: ReturnType<typeof userEvent.setup>, code = 'ui-token') => {
  render(<App />);
  await user.type(screen.getByLabelText('Shop access code'), code);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
};

describe('UI end to end', () => {
  it('rejects a wrong access code with a clear message', async () => {
    const user = userEvent.setup();
    await signIn(user, 'nope');
    expect((await screen.findByRole('alert')).textContent).toMatch(/access code didn't work/);
  });

  it('takes a lead from the quick-lead form all the way to Paid with a warranty', async () => {
    const user = userEvent.setup();
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();

    await user.click(screen.getAllByRole('link', { name: 'New lead' })[0]);
    await user.type(await screen.findByLabelText('Mobile'), '(214) 555-7788');
    await user.type(screen.getByLabelText('First name'), 'Marcus');
    await user.type(screen.getByLabelText('Year'), '2023');
    await user.type(screen.getByLabelText('Make'), 'Tesla');
    await user.type(screen.getByLabelText('Model'), 'Model Y');
    await user.click(screen.getByRole('button', { name: 'Create lead' }));

    // Lands on the job page.
    expect(await screen.findByRole('heading', { name: 'Marcus' })).toBeTruthy();
    expect(screen.getByText('2023 Tesla Model Y')).toBeTruthy();

    // Quote: 20% front sides triggers the Texas waiver warning.
    await screen.findByRole('option', { name: 'Nano Ceramic' });
    await user.selectOptions(screen.getByLabelText('Film'), 'Nano Ceramic');
    await user.selectOptions(screen.getByLabelText('Shade'), '20');
    await user.type(screen.getByLabelText('Price ($)'), '450');
    await user.click(screen.getByRole('button', { name: 'Add service' }));
    await screen.findAllByText('$450.00');
    expect(screen.getByText(/below the Texas 25% limit/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Mark quoted' }));
    await screen.findByRole('button', { name: 'Mark booked' });

    // Book: auto-moves to Booked.
    const date = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    await user.clear(screen.getByLabelText('Date'));
    await user.type(screen.getByLabelText('Date'), date);
    await user.click(screen.getByRole('button', { name: 'Book' }));
    await user.click(await screen.findByRole('button', { name: 'Start install' }));
    await user.click(await screen.findByRole('button', { name: 'Mark completed' }));

    // Blocked until the waiver is signed.
    expect((await screen.findByRole('alert')).textContent).toMatch(/signed customer acknowledgment/);
    await user.type(screen.getByLabelText("Customer's full name"), 'Marcus Reed');
    await user.click(screen.getByRole('button', { name: 'Record signature' }));
    await screen.findByText(/Shade acknowledgment signed/);
    await user.click(screen.getByRole('button', { name: 'Mark completed' }));
    await screen.findByRole('button', { name: 'Reopen install' });

    // One tap records the full balance: job settles to Paid and warranties appear.
    const payCard = screen.getByRole('button', { name: /Paid by card/ });
    expect(payCard.textContent).toContain('$487.13'); // 450.00 + 8.25% tax
    await user.click(payCard);
    // Nothing is recorded until the confirmation sheet is answered.
    const sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toMatch(/Record \$487\.13 paid by card\?/);
    expect(sheet.textContent).toMatch(/Marcus gets a receipt text with the warranty numbers/);
    await user.click(within(sheet).getByRole('button', { name: 'Yes, record $487.13' }));
    await screen.findByRole('heading', { name: 'Warranties' });
    expect(screen.getAllByText(/^DS-\d+-M1$/).length).toBe(1);
    expect(screen.getByText('Paid', { selector: '.pill' })).toBeTruthy();

    // Warranty lookup by phone finds it.
    await user.click(screen.getAllByRole('link', { name: 'Warranties' })[0]);
    await user.type(await screen.findByLabelText(/Name, phone, email, plate/), '214-555-7788');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getAllByText(/^DS-\d+-(M1|L1)$/).length).toBe(2));

    // ...and by name, with the phone shown so staff can confirm it's the right Marcus.
    const box = screen.getByLabelText(/Name, phone, email, plate/);
    await user.clear(box);
    await user.type(box, 'marcus');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getAllByText(/Marcus, \(214\) 555-7788/).length).toBe(2));
  });

  it('shows the API error instead of crashing on overpayment', async () => {
    const user = userEvent.setup();
    const lead = await (await fetch('/api/leads', { method: 'POST',
      headers: { authorization: 'Bearer ui-token', 'content-type': 'application/json' },
      body: JSON.stringify({ contact: { mobile: '2145557799' }, vehicle: { make: 'Ford' } }) })).json();
    await fetch(`/api/jobs/${lead.job.id}/line-items`, { method: 'POST',
      headers: { authorization: 'Bearer ui-token', 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'windshield', unit_price_cents: 10000 }) });
    location.hash = `#/jobs/${lead.job.id}`;
    await signIn(user);
    await user.click(await screen.findByText('Other amount, deposit or refund'));
    const amount = screen.getByLabelText('Amount ($)') as HTMLInputElement;
    expect(amount.value).toBe('108.25'); // prefilled immediately
    await user.clear(amount);
    await user.type(amount, '9999');
    expect(amount.value).toBe('9999');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Yes, record/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/exceeds the balance/);
  });

  it('BUG 13: a server outage shows a readable message, not a JSON parse error', async () => {
    const user = userEvent.setup();
    const ok = globalThis.fetch;
    await signIn(user);
    await screen.findByRole('heading', { name: 'Today' });
    globalThis.fetch = (async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    try {
      await user.click(screen.getAllByRole('link', { name: 'Warranties' })[0]);
      await user.type(await screen.findByLabelText(/Name, phone, email, plate/), 'ABC1234');
      await user.click(screen.getByRole('button', { name: 'Search' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/server/i);
      expect(alert.textContent).not.toMatch(/JSON|Unexpected token/);
    } finally {
      globalThis.fetch = ok;
    }
  });

  it('BUG 14: when the access code stops working, staff are sent back to sign in', async () => {
    const user = userEvent.setup();
    await signIn(user);
    await screen.findByRole('heading', { name: 'Today' });
    localStorage.setItem('daspot.staffToken', 'revoked-code');
    await user.click(screen.getAllByRole('link', { name: 'Warranties' })[0]);
    await user.type(await screen.findByLabelText(/Name, phone, email, plate/), 'ABC1234');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByLabelText('Shop access code')).toBeTruthy();
  });

  it('phone board: stage tabs pick which column shows, and the choice sticks', async () => {
    const user = userEvent.setup();
    sessionStorage.clear();
    location.hash = '#/pipeline';
    await signIn(user);
    const tabs = await screen.findByRole('tablist', { name: 'Stage' });
    const paidTab = within(tabs).getByRole('tab', { name: /Paid/ });
    await user.click(paidTab);
    expect(paidTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('region', { name: 'Paid' }).className).toContain('active');
    expect(screen.getByRole('region', { name: 'New lead' }).className).not.toContain('active');
    expect(sessionStorage.getItem('daspot.boardStage')).toBe('paid');
    sessionStorage.clear();
  });

  it('phone job page: Call and Text dial the customer', async () => {
    const user = userEvent.setup();
    const lead = await (await fetch('/api/leads', { method: 'POST',
      headers: { authorization: 'Bearer ui-token', 'content-type': 'application/json' },
      body: JSON.stringify({ contact: { first_name: 'Dana', mobile: '2145550190' } }) })).json();
    location.hash = `#/jobs/${lead.job.id}`;
    await signIn(user);
    expect((await screen.findByRole('link', { name: 'Call' })).getAttribute('href')).toBe('tel:+12145550190');
    expect(screen.getByRole('link', { name: 'Text' }).getAttribute('href')).toBe('sms:+12145550190');
  });

  it('imports past clients and shows each warranty date before saving', async () => {
    const user = userEvent.setup();
    const csv = [
      'Customer Name,Phone #,Vehicle,Install Date,Film,Warranty #,Warranty Expires',
      'Rosa Delgado,(214) 555-0201,2022 Nissan Altima,04/05/2024,Carbon,W-77,04/05/2029',
      'Hugo Rey,2145550202,2018 Ford F-150,6/30/2023,Nano Ceramic,,',
      'Nobody,,,,,,',
    ].join('\n');
    location.hash = '#/import';
    await signIn(user);
    await user.upload(await screen.findByLabelText(/Choose spreadsheet file/), new File([csv], 'clients.csv', { type: 'text/csv' }));

    // US order by default: 04/05/2024 is April 5.
    expect(await screen.findByText('Apr 5, 2024 to Apr 5, 2029')).toBeTruthy();
    expect(screen.getByText('Jun 30, 2023 to lifetime')).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();

    // Switching to day-first re-reads both dates on that row as May 4 (the June 30 row can't be day-first).
    await user.click(screen.getByRole('button', { name: /Day first/ }));
    expect(await screen.findByText('May 4, 2024 to May 4, 2029')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Month first/ }));
    await screen.findByText('Apr 5, 2024 to Apr 5, 2029');

    await user.click(screen.getByRole('button', { name: /Import 2 rows/ }));
    expect(await screen.findByRole('heading', { name: 'Import finished' })).toBeTruthy();

    // The imported warranty is findable by its old number with the same dates.
    const found = await (await fetch('/api/warranties/lookup?q=W-77', { headers: { authorization: 'Bearer ui-token' } })).json();
    expect(found[0]).toMatchObject({ starts_on: '2024-04-05', expires_on: '2029-04-05', first_name: 'Rosa' });
  });

  it('a mis-tap on a payment or Remove changes nothing until confirmed', async () => {
    const user = userEvent.setup();
    const H = { authorization: 'Bearer ui-token', 'content-type': 'application/json' };
    const lead = await (await fetch('/api/leads', { method: 'POST', headers: H,
      body: JSON.stringify({ contact: { first_name: 'Tess', mobile: '2145550188' }, vehicle: { make: 'Audi' } }) })).json();
    await fetch(`/api/jobs/${lead.job.id}/line-items`, { method: 'POST', headers: H, body: JSON.stringify({ service: 'windshield', unit_price_cents: 20000 }) });
    location.hash = `#/jobs/${lead.job.id}`;
    await signIn(user);

    await user.click(await screen.findByRole('button', { name: /Paid cash/ }));
    let sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toMatch(/Record \$216\.50 paid in cash\?/);
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Remove Windshield' }));
    sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toMatch(/\$200\.00 comes off the quote/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const job = await (await fetch(`/api/jobs/${lead.job.id}`, { headers: H })).json();
    expect(job.payments).toEqual([]);
    expect(job.line_items).toHaveLength(1);
  });

  it('shows new leads on the board in the right column', async () => {
    const user = userEvent.setup();
    location.hash = '#/pipeline';
    await signIn(user);
    const col = await screen.findByRole('region', { name: 'New lead' });
    await waitFor(() => expect(within(col).getAllByRole('link').length).toBeGreaterThan(0));
  });
  it('home: Add appointment books a new client and shows them on today\'s schedule', async () => {
    const user = userEvent.setup();
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();
    await user.click(screen.getAllByRole('link', { name: 'Add appointment' })[0]);
    await user.click(await screen.findByRole('tab', { name: 'New client' }));
    await user.type(screen.getByLabelText('Mobile'), '(214) 555-6120');
    await user.type(screen.getByLabelText('First name'), 'Rosa');
    await user.type(screen.getByLabelText('Last name'), 'Delgado');
    await user.type(screen.getByLabelText('Year'), '2022');
    await user.type(screen.getByLabelText('Make'), 'Nissan');
    await user.type(screen.getByLabelText('Model'), 'Altima');
    await user.selectOptions(screen.getByLabelText('Service'), 'full_tint');
    await user.type(screen.getByLabelText('Price ($)'), '300');
    await user.selectOptions(screen.getByLabelText('Start'), '15:00');
    await user.selectOptions(screen.getByLabelText('Bay'), '3');
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    const sched = await screen.findByRole('region', { name: 'Schedule' });
    await waitFor(() => expect(within(sched).getByText('Rosa Delgado')).toBeTruthy());
    expect(within(sched).getByText('3:00 PM')).toBeTruthy();
    expect(within(sched).getByText('Bay 3')).toBeTruthy();
    expect(within(sched).getByText('Full tint')).toBeTruthy();
    expect(within(sched).getByText('Booked')).toBeTruthy();
  });

  it('Add appointment: finds an existing client and books their open quote', async () => {
    const H = { authorization: 'Bearer ui-token', 'content-type': 'application/json' };
    const lead = await (await fetch('/api/leads', { method: 'POST', headers: H, body: JSON.stringify({
      contact: { mobile: '9725556677', first_name: 'Teodoro', last_name: 'Quintana' }, vehicle: { year: 2020, make: 'Ram', model: '1500' } }) })).json();
    await fetch(`/api/jobs/${lead.job.id}/line-items`, { method: 'POST', headers: H, body: JSON.stringify({ service: 'windshield', unit_price_cents: 22000 }) });
    await fetch(`/api/jobs/${lead.job.id}/stage`, { method: 'POST', headers: H, body: JSON.stringify({ to: 'quoted' }) });

    const user = userEvent.setup();
    location.hash = '#/book';
    await signIn(user);
    await user.type(await screen.findByLabelText('Search by name or phone'), 'Teodoro');
    await user.click(await screen.findByRole('button', { name: /Teodoro Quintana/ }));
    const what = await screen.findByRole('radiogroup', { name: 'What is this for?' });
    const quote = within(what).getByRole('radio', { name: new RegExp(`#${lead.job.number}`) }) as HTMLInputElement;
    expect(quote.checked).toBe(true);
    expect(screen.queryByLabelText('Make')).toBeNull(); // the quote already has the truck
    await user.selectOptions(screen.getByLabelText('Bay'), '2');
    await user.selectOptions(screen.getByLabelText('Start'), '08:00');
    await user.click(screen.getByRole('button', { name: 'Book appointment' }));
    const sched = await screen.findByRole('region', { name: 'Schedule' });
    await waitFor(() => expect(within(sched).getByText('Teodoro Quintana')).toBeTruthy());
    const job = await (await fetch(`/api/jobs/${lead.job.id}`, { headers: H })).json();
    expect(job.stage).toBe('booked');
    expect(job.appointments).toHaveLength(1);
  });
  it('connect calendar: gives Johnathan an iPhone link to the bookings feed', async () => {
    const user = userEvent.setup();
    await signIn(user);
    await user.click(await screen.findByRole('link', { name: /Connect your phone calendar/ }));
    await user.type(await screen.findByLabelText('Whose calendar is this?'), 'Johnathan');
    await user.click(screen.getByRole('button', { name: 'Get my calendar link' }));
    const iphone = await screen.findByRole('link', { name: 'Add to iPhone Calendar' });
    expect(iphone.getAttribute('href')).toMatch(/^webcal:\/\/.+\/calendar\/johnathan-[0-9a-f]{24}\.ics$/);
    const google = screen.getByRole('link', { name: 'Add to Google Calendar' });
    expect(google.getAttribute('href')).toContain('calendar.google.com');
    const url = screen.getByLabelText('Calendar link').textContent!;
    const feed = await fetch(new URL(url).pathname);
    expect(feed.status).toBe(200);
    expect(await feed.text()).toContain('BEGIN:VCALENDAR');
    expect(localStorage.getItem('daspot.calendarName')).toBe('Johnathan');
  });
  it('job page: reschedule moves the appointment, cancel takes it off and the job goes back to Quoted', async () => {
    const H = { authorization: 'Bearer ui-token', 'content-type': 'application/json' };
    const day = new Date(Date.now() + 10 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const next = new Date(Date.now() + 11 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const out = await (await fetch('/api/appointments', { method: 'POST', headers: H, body: JSON.stringify({
      contact: { mobile: '4695550777', first_name: 'Paola', last_name: 'Reyes' }, vehicle: { make: 'Mazda', model: 'CX-5' },
      slot: { starts_at: `${day}T15:00:00.000Z`, ends_at: `${day}T17:00:00.000Z`, bay: 1 } }) })).json();

    const user = userEvent.setup();
    location.hash = `#/jobs/${out.job_id}`;
    await signIn(user);
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }));
    const dateInput = screen.getAllByLabelText('Date').find((el) => el.id === 'move-date') as HTMLInputElement;
    expect(dateInput.value).toBe(day);
    await user.clear(dateInput);
    await user.type(dateInput, next);
    await user.selectOptions(screen.getAllByLabelText('Bay').find((el) => el.id === 'move-bay')!, '3');
    await user.click(screen.getByRole('button', { name: 'Move it' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Move it' })).toBeNull());
    expect(screen.getByText(/Bay 3/)).toBeTruthy();
    let job = await (await fetch(`/api/jobs/${out.job_id}`, { headers: H })).json();
    expect(job.appointments[0].bay).toBe(3);
    expect(new Date(job.appointments[0].starts_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })).toBe(next);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toMatch(/goes back to Quoted/);
    await user.click(within(sheet).getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull());
    job = await (await fetch(`/api/jobs/${out.job_id}`, { headers: H })).json();
    expect(job.stage).toBe('quoted');
    expect(job.appointments[0].status).toBe('cancelled');
  });

  it('home: 7 days shows the week by day and links each booking to its job', async () => {
    const H = { authorization: 'Bearer ui-token', 'content-type': 'application/json' };
    const day = new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const out = await (await fetch('/api/appointments', { method: 'POST', headers: H, body: JSON.stringify({
      contact: { mobile: '2145550888', first_name: 'Weekly', last_name: 'Visitor' }, vehicle: { year: 2021, make: 'Jeep', model: 'Wrangler' },
      slot: { starts_at: `${day}T21:00:00.000Z`, ends_at: `${day}T22:00:00.000Z`, bay: 2 } }) })).json();
    const user = userEvent.setup();
    await signIn(user);
    await user.click(await screen.findByRole('link', { name: '7 days' }));
    expect(await screen.findByRole('heading', { name: 'Next 7 days' })).toBeTruthy();
    const longDay = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const col = await screen.findByRole('region', { name: longDay });
    const item = within(col).getByRole('link', { name: /Weekly Visitor/ });
    expect(item.getAttribute('href')).toBe(`#/jobs/${out.job_id}`);
    expect(item.textContent).toMatch(/Bay 2/);
    expect(screen.getAllByRole('region').length).toBeGreaterThanOrEqual(7);
  });
});
