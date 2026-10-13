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

    // Pay the full balance (form is prefilled): job settles to Paid and warranties appear.
    const amount = screen.getByLabelText('Amount ($)') as HTMLInputElement;
    expect(amount.value).toBe('487.13'); // 450.00 + 8.25% tax
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByRole('heading', { name: 'Warranties' });
    expect(screen.getAllByText(/^DS-\d+-M1$/).length).toBe(1);
    expect(screen.getByText('Paid', { selector: '.pill' })).toBeTruthy();

    // Warranty lookup by phone finds it.
    await user.click(screen.getByRole('link', { name: 'Warranties' }));
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
    const amount = (await screen.findByLabelText('Amount ($)')) as HTMLInputElement;
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
      await user.click(screen.getByRole('link', { name: 'Warranties' }));
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
    await user.click(screen.getByRole('link', { name: 'Warranties' }));
    await user.type(await screen.findByLabelText(/Name, phone, email, plate/), 'ABC1234');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByLabelText('Shop access code')).toBeTruthy();
  });

  it('shows new leads on the board in the right column', async () => {
    const user = userEvent.setup();
    await signIn(user);
    const col = await screen.findByRole('region', { name: 'New lead' });
    await waitFor(() => expect(within(col).getAllByRole('link').length).toBeGreaterThan(0));
  });
});
