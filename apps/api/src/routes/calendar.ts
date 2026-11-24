import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { notFound } from '../lib/errors.js';
import { SHOP_TZ } from '../lib/warranty.js';

/**
 * Calendar connection: each person gets a private subscription link (an .ics feed) that their
 * phone's calendar checks on its own. Every booking, reschedule and cancellation in the CRM shows up
 * there without anyone touching the calendar.
 *
 * Links are signed, not stored, so they keep working across restarts. Changing CALENDAR_SECRET
 * (or the shop access code, when no separate secret is set) turns every old link off.
 */
const SERVICES: Record<string, string> = {
  full_tint: 'Full tint', front_two: 'Front two', windshield: 'Windshield', sun_strip: 'Sun strip',
  pano_roof: 'Panoramic roof', removal: 'Old film removal', wrap: 'Wrap', chrome_delete: 'Chrome delete',
  lights: 'Lights', flat_glass: 'Home / storefront', other: 'Other',
};

const slug = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'shop';

export function feedToken(secret: string, name: string) {
  const s = slug(name);
  return `${s}-${crypto.createHmac('sha256', secret).update(`calendar:${s}`).digest('hex').slice(0, 24)}`;
}

function checkToken(secret: string, token: string) {
  const m = token.match(/^([a-z0-9-]{1,30})-([0-9a-f]{24})$/);
  if (!m) return false;
  const want = Buffer.from(feedToken(secret, m[1]));
  const got = Buffer.from(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Public address of this server, as the caller reached it. */
const baseUrl = (req: Request, configured: string) => configured || `${req.protocol}://${req.get('host')}`;

export function calendarLinks(req: Request, secret: string, configuredBase: string, name: string) {
  const https = `${baseUrl(req, configuredBase)}/calendar/${feedToken(secret, name)}.ics`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  return {
    name: name.trim(),
    url: https,
    webcal_url: webcal,
    google_url: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
  };
}

/* ---------- iCalendar (RFC 5545) ---------- */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Lines longer than 75 bytes are folded, continuing on the next line after a space. */
function fold(line: string) {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export interface FeedAppointment {
  appointment_id: string; starts_at: Date | string; ends_at: Date | string; bay: number; status: string;
  job_id: string; number: number; stage: string;
  first_name: string | null; last_name: string | null; mobile: string;
  year: number | null; make: string | null; model: string | null; services: string[]; note: string | null;
}

export function buildIcs(rows: FeedAppointment[], opts: { calName: string; jobUrl: (id: string) => string; now?: Date }) {
  const now = stamp(opts.now ?? new Date());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Da Spot 214//CRM//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(opts.calName)}`, `X-WR-TIMEZONE:${SHOP_TZ}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
  ];
  for (const a of rows) {
    const who = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.mobile;
    const car = [a.year, a.make, a.model].filter(Boolean).join(' ');
    const services = [...new Set(a.services)].map((s) => SERVICES[s] ?? s).join(', ');
    const phone = a.mobile.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
    const details = [
      `Job #${a.number}`, car && `Vehicle: ${car}`, services && `Services: ${services}`, `Phone: ${phone}`,
      a.note && `Note: ${a.note}`, `Open in the CRM: ${opts.jobUrl(a.job_id)}`,
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${a.appointment_id}@daspot214-crm`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(new Date(a.starts_at))}`,
      `DTEND:${stamp(new Date(a.ends_at))}`,
      `SUMMARY:${esc(`${who}${car ? ` · ${car}` : ''}`)}`,
      'LOCATION:Da Spot 214',
      `DESCRIPTION:${esc(details)}`,
      `URL:${opts.jobUrl(a.job_id)}`,
      'STATUS:CONFIRMED',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`Tomorrow: ${who}`)}`, 'TRIGGER:-P1D', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`In 1 hour: ${who}`)}`, 'TRIGGER:-PT1H', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Staff-only: make a person's calendar link. Mounted under /api. */
export function calendarApiRouter({ config }: Deps) {
  const r = Router();
  r.get('/calendar/link', (req, res) => {
    const name = z.string().trim().min(1).max(40).catch('Shop').parse(req.query.name);
    res.json(calendarLinks(req, config.calendarSecret || config.staffToken, config.publicBaseUrl, name));
  });
  return r;
}

/** Public, but only with a valid signed link. What the phone's calendar app downloads. */
export function calendarFeedRouter({ db, config }: Deps) {
  const r = Router();
  r.get('/:file', async (req, res) => {
    const token = String(req.params.file).replace(/\.ics$/, '');
    if (!checkToken(config.calendarSecret || config.staffToken, token)) throw notFound('Calendar');
    const { rows } = await db.query<FeedAppointment>(
      `SELECT a.id AS appointment_id, a.starts_at, a.ends_at, a.bay, a.status,
              j.id AS job_id, j.number, j.stage, c.first_name, c.last_name, c.mobile, v.year, v.make, v.model,
              ARRAY(SELECT li.service FROM job_line_items li WHERE li.job_id = j.id ORDER BY li.service) AS services,
              (SELECT n.body FROM notes n WHERE n.subject_type = 'job' AND n.subject_id = j.id
                ORDER BY n.created_at DESC LIMIT 1) AS note
         FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         JOIN contacts c ON c.id = j.contact_id
         LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE a.status NOT IN ('cancelled','no_show') AND j.stage <> 'lost'
          AND a.starts_at > now() - interval '60 days' AND a.starts_at < now() + interval '365 days'
        ORDER BY a.starts_at`);
    const base = baseUrl(req, config.publicBaseUrl);
    res.set({
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-disposition': 'inline; filename="da-spot-214.ics"',
    });
    res.send(buildIcs(rows, { calName: 'Da Spot 214 bookings', jobUrl: (id) => `${base}/#/jobs/${id}` }));
  });
  return r;
}
