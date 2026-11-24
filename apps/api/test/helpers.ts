import request from 'supertest';
import { createApp } from '../src/app.js';
import { createMemoryDb, migrate, type Db } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { FakeSender } from '../src/lib/messaging.js';
import { FakeEmailSender } from '../src/lib/email.js';

export const TOKEN = 'test-token';

export async function setup(opts: { twilioAuthToken?: string; publicBaseUrl?: string; shopPhone?: string; shopAddress?: string } = {}) {
  const db: Db = await createMemoryDb();
  await migrate(db);
  await seed(db);
  const sender = new FakeSender();
  const email = new FakeEmailSender();
  const app = createApp({
    db,
    sender,
    email,
    config: { staffToken: TOKEN, twilioAuthToken: opts.twilioAuthToken ?? '', publicBaseUrl: opts.publicBaseUrl ?? '',
      shopPhone: opts.shopPhone, shopAddress: opts.shopAddress },
  });
  const api = {
    get: (url: string) => request(app).get(url).set('authorization', `Bearer ${TOKEN}`),
    post: (url: string, body?: object) => request(app).post(url).set('authorization', `Bearer ${TOKEN}`).send(body ?? {}),
    patch: (url: string, body?: object) => request(app).patch(url).set('authorization', `Bearer ${TOKEN}`).send(body ?? {}),
    del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${TOKEN}`),
  };
  const films = (await db.query('SELECT id, line FROM film_products')).rows as { id: string; line: string }[];
  const film = (line: string) => films.find((f) => f.line === line)!.id;
  return { db, app, api, sender, email, film };
}

let phoneSeq = 100;
/** A fresh valid Dallas mobile number for each call. */
export const nextPhone = () => `+1214555${String(phoneSeq++).padStart(4, '0')}`;
