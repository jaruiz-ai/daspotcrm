import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { createApp } from './app.js';
import { createMemoryDb, createPgDb, migrate } from './db/index.js';
import { seed } from './db/seed.js';
import { loadDemoData } from './demo.js';
import { FakeSender, TwilioSender, type MessageSender } from './lib/messaging.js';
import { ResendSender } from './lib/email.js';

/**
 * Vercel Function entry. One app per warm instance, built on the first request.
 *
 * DEMO_MODE=1 is the test site: texts are logged instead of sent, Twilio settings are optional,
 * and sample customers are loaded into an empty database. Without DATABASE_URL the data lives in
 * memory and resets whenever Vercel starts a fresh instance.
 */
const env = process.env;
let ready: Promise<Express> | undefined;

async function build(): Promise<Express> {
  const demo = env.DEMO_MODE === '1';
  const staffToken = env.STAFF_API_TOKEN ?? '';
  if (staffToken.length < 12) throw new Error('STAFF_API_TOKEN must be set (12+ characters).');
  const twilioReady = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM);
  if (!demo && (!twilioReady || !env.PUBLIC_BASE_URL || staffToken.length < 24)) {
    throw new Error('Live mode needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM, PUBLIC_BASE_URL and a 24+ character STAFF_API_TOKEN.');
  }

  const db = env.DATABASE_URL ? await createPgDb(env.DATABASE_URL) : await createMemoryDb();
  await migrate(db);
  if (demo) await seed(db);

  let sender: MessageSender;
  if (!demo && twilioReady) {
    sender = new TwilioSender(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!, env.TWILIO_SMS_FROM!,
      env.TWILIO_WHATSAPP_FROM ?? env.TWILIO_SMS_FROM!);
  } else {
    sender = new FakeSender();
  }

  const app = createApp({
    db,
    sender,
    email: env.RESEND_API_KEY ? new ResendSender(env.RESEND_API_KEY, env.EMAIL_FROM ?? 'Da Spot 214 <bookings@daspot214.com>', env.EMAIL_REPLY_TO) : undefined,
    config: {
      staffToken,
      // Test site: signature checks are off so sample texts can be posted to the webhook by hand.
      twilioAuthToken: demo ? '' : env.TWILIO_AUTH_TOKEN!,
      publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
      calendarSecret: env.CALENDAR_SECRET,
      shopPhone: env.SHOP_PHONE,
      shopAddress: env.SHOP_ADDRESS,
    },
  });
  if (demo) await loadDemoData(db, app, staffToken);
  return app;
}

/** Rewrites send /api/* and /webhooks/* here with the original path in ?__p=; restore it for Express. */
export async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  const original = url.searchParams.get('__p');
  if (original !== null) {
    url.searchParams.delete('__p');
    const qs = url.searchParams.toString();
    req.url = '/' + original.replace(/^\/+/, '') + (qs ? `?${qs}` : '');
  }
  try {
    ready ??= build();
    const app = await ready;
    app(req as any, res as any);
  } catch (err) {
    ready = undefined; // try again on the next request
    console.error('Startup failed:', err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'starting_up_failed', message: 'The CRM could not start. Check the deployment logs.' }));
  }
}
