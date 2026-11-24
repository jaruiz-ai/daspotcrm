import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z, ZodError } from 'zod';
import type { Db } from './db/index.js';
import type { MessageSender } from './lib/messaging.js';
import { FakeEmailSender, type EmailSender } from './lib/email.js';
import { HttpError, fromPgError } from './lib/errors.js';
import { contactsRouter } from './routes/contacts.js';
import { jobsRouter } from './routes/jobs.js';
import { warrantiesRouter } from './routes/warranties.js';
import { adminRouter } from './routes/admin.js';
import { webhooksRouter } from './routes/webhooks.js';
import { importsRouter } from './routes/imports.js';
import { scheduleRouter } from './routes/schedule.js';
import { calendarApiRouter, calendarFeedRouter } from './routes/calendar.js';

export interface AppConfig {
  /** Bearer token staff apps send. Required outside tests. */
  staffToken: string;
  /** Twilio auth token for webhook signature checks. Empty disables checks (local dev only). */
  twilioAuthToken: string;
  /** Public base URL Twilio calls, e.g. https://admin.daspot214.com — needed to verify signatures. */
  publicBaseUrl: string;
  /** Signs calendar subscription links. Falls back to the staff token when not set. */
  calendarSecret?: string;
  /** Shop phone and address, printed in client emails. Left out when not set. */
  shopPhone?: string;
  shopAddress?: string;
  /** Logo shown at the top of client emails (a public https URL). */
  logoUrl?: string;
  /** Built web app (apps/web/dist). When set, the API also serves the staff app from the same address. */
  webDir?: string;
}

export interface Deps {
  db: Db;
  sender: MessageSender;
  config: AppConfig;
  /** Client emails (booking confirmations). Defaults to a recorder that sends nothing. */
  email?: EmailSender;
}

export function createApp(input: Deps) {
  const deps: Deps = { ...input, email: input.email ?? new FakeEmailSender() };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      // Only this site may frame the CRM (blocks clickjacking).
      'Content-Security-Policy': "frame-ancestors 'self'",
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    await deps.db.query('SELECT 1');
    res.json({ ok: true });
  });

  // Calendar apps fetch this without signing in; the link itself is the key.
  app.use('/calendar', calendarFeedRouter(deps));

  // Webhooks authenticate by signature, not the staff token.
  app.use('/webhooks', express.urlencoded({ extended: false, limit: '256kb' }), webhooksRouter(deps));

  app.use('/api', express.json({ limit: '3mb' }), requireStaff(deps.config.staffToken));
  app.use('/api', contactsRouter(deps));
  app.use('/api', jobsRouter(deps));
  app.use('/api', warrantiesRouter(deps));
  app.use('/api', adminRouter(deps));
  app.use('/api', importsRouter(deps));
  app.use('/api', scheduleRouter(deps));
  app.use('/api', calendarApiRouter(deps));

  const webDir = deps.config.webDir;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    // Any other GET outside the API is the single-page app.
    app.get(/^\/(?!api\/|api$|webhooks\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(webDir, 'index.html'));
    });
  }

  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}

function requireStaff(token: string) {
  if (!token) throw new Error('STAFF_API_TOKEN must be set');
  const expected = Buffer.from(token);
  return (req: Request, _res: Response, next: NextFunction) => {
    const given = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return next(new HttpError(401, 'unauthorized', 'Missing or invalid token'));
    }
    next();
  };
}

function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'validation', message: 'Invalid request', details: z.flattenError(err) } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  }
  const httpErr = err instanceof HttpError ? err : fromPgError(err);
  if (httpErr) {
    return res.status(httpErr.status).json({ error: { code: httpErr.code, message: httpErr.message, details: httpErr.details } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
