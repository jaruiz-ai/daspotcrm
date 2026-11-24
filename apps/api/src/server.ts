import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createMemoryDb, createPgDb, migrate } from './db/index.js';
import { FakeSender, TwilioSender, type MessageSender } from './lib/messaging.js';
import { seed } from './db/seed.js';

const env = process.env;
// Any run against a real database is treated as production, whatever NODE_ENV says.
const isProd = env.NODE_ENV === 'production' || !!env.DATABASE_URL;

// Check configuration before touching the database so a bad deploy fails fast and clearly.
const problems: string[] = [];
if (isProd) {
  if (!env.STAFF_API_TOKEN || env.STAFF_API_TOKEN.length < 24) problems.push('STAFF_API_TOKEN (random, 24+ characters)');
  if (!env.TWILIO_ACCOUNT_SID) problems.push('TWILIO_ACCOUNT_SID');
  if (!env.TWILIO_AUTH_TOKEN) problems.push('TWILIO_AUTH_TOKEN');
  if (!env.TWILIO_SMS_FROM) problems.push('TWILIO_SMS_FROM');
  if (!env.PUBLIC_BASE_URL) problems.push('PUBLIC_BASE_URL (needed to verify Twilio webhooks)');
}
if (problems.length) {
  console.error(`Missing configuration:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const db = env.DATABASE_URL ? await createPgDb(env.DATABASE_URL) : await createMemoryDb();
await migrate(db);
if (!env.DATABASE_URL) {
  await seed(db);
  console.log('No DATABASE_URL set — using an in-memory database with demo data.');
}

let sender: MessageSender;
if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM) {
  sender = new TwilioSender(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_SMS_FROM,
    env.TWILIO_WHATSAPP_FROM ?? env.TWILIO_SMS_FROM);
} else {
  sender = new FakeSender();
  console.log('Twilio not configured — outbound texts are logged, not sent.');
}

const app = createApp({
  db,
  sender,
  config: {
    staffToken: env.STAFF_API_TOKEN ?? 'dev-token', // dev-token only reachable in demo mode (checked above)
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? '',
    publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
      calendarSecret: env.CALENDAR_SECRET,
    // apps/api/{src|dist}/server → apps/web/dist
    webDir: env.WEB_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  },
});

const port = Number(env.PORT) || 4000;
const server = app.listen(port, () => console.log(`Da Spot CRM API on http://localhost:${port}`));

const shutdown = () => server.close(() => db.close().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
