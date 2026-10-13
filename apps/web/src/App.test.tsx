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
    expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeTruthy();

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

    // One tap after running the card on the Chase reader: job settles to Paid and warranties appear.
    const payCard = screen.getByRole('button', { name: /Paid by card/ });
    expect(payCard.textContent).toContain('$487.13'); // 450.00 + 8.25% tax
    await user.click(payCard);
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
    expect((await screen.findByRole('alert')).textContent).toMatch(/exceeds the balance/);
  });

  it('BUG 13: a server outage shows a readable message, not a JSON parse error', async () => {
    const user = userEvent.setup();
    const ok = globalThis.fetch;
    await signIn(user);
    await screen.findByRole('heading', { name: 'Pipeline' });
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
    await screen.findByRole('heading', { name: 'Pipeline' });
    localStorage.setItem('daspot.staffToken', 'revoked-code');
    await user.click(screen.getAllByRole('link', { name: 'Warranties' })[0]);
    await user.type(await screen.findByLabelText(/Name, phone, email, plate/), 'ABC1234');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByLabelText('Shop access code')).toBeTruthy();
  });

  it('phone board: stage tabs pick which column shows, and the choice sticks', async () => {
    const user = userEvent.setup();
    sessionStorage.clear();
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

  it('Chase check: upload a report, see what is missing, record it in one tap', async () => {
    const user = userEvent.setup();
    const H = { authorization: 'Bearer ui-token', 'content-type': 'application/json' };
    const lead = await (await fetch('/api/leads', { method: 'POST', headers: H,
      body: JSON.stringify({ contact: { first_name: 'Nina', mobile: '2145550177' }, vehicle: { make: 'Mazda', model: 'CX-5' } }) })).json();
    await fetch(`/api/jobs/${lead.job.id}/line-items`, { method: 'POST', headers: H,
      body: JSON.stringify({ service: 'full_tint', unit_price_cents: 30000 }) });
    const today = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const csv = `Transaction Date,Time,Status,Amount,Transaction ID\n${today},9:30 AM,Approved,$324.75,UI-77\n`;

    location.hash = '#/payments';
    await signIn(user);
    await user.upload(await screen.findByLabelText(/Choose Chase report/), new File([csv], 'chase.csv', { type: 'text/csv' }));
    const pick = await screen.findByRole('button', { name: /Record on #\d+, Nina, Mazda CX-5/ });
    await user.click(pick);
    expect(await screen.findByText(/Recorded on job #\d+/)).toBeTruthy();
    // Re-checked after recording: nothing on Chase is missing from the CRM any more.
    await waitFor(() => expect(screen.getByLabelText('Summary').textContent).toContain('0on Chase, not in CRM'));
  });

  it('shows new leads on the board in the right column', async () => {
    const user = userEvent.setup();
    await signIn(user);
    const col = await screen.findByRole('region', { name: 'New lead' });
    await waitFor(() => expect(within(col).getAllByRole('link').length).toBeGreaterThan(0));
  });
});
