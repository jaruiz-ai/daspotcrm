import type { Queryable } from '../db/index.js';
import type { EmailSender } from './email.js';
import { SHOP_TZ } from './warranty.js';
import { logActivity } from '../routes/shared.js';

export type ConfirmationKind = 'booked' | 'moved' | 'cancelled';

const SERVICES: Record<'en' | 'es', Record<string, string>> = {
  en: {
    full_tint: 'Full tint', front_two: 'Front two windows', windshield: 'Windshield', sun_strip: 'Sun strip',
    pano_roof: 'Panoramic roof', removal: 'Old film removal', wrap: 'Wrap', chrome_delete: 'Chrome delete',
    lights: 'Light tint', flat_glass: 'Home / storefront tint', other: 'Other',
  },
  es: {
    full_tint: 'Polarizado completo', front_two: 'Dos ventanas delanteras', windshield: 'Parabrisas', sun_strip: 'Franja solar',
    pano_roof: 'Techo panorámico', removal: 'Quitar polarizado viejo', wrap: 'Wrap', chrome_delete: 'Chrome delete',
    lights: 'Polarizado de luces', flat_glass: 'Casa / local', other: 'Otro',
  },
};

export interface ConfirmationData {
  kind: ConfirmationKind;
  lang: 'en' | 'es';
  firstName: string | null;
  startsAt: Date;
  endsAt: Date;
  vehicle: string;
  services: string[];
  jobNumber: number;
  appointmentId: string;
  shop: { phone?: string; address?: string };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function when(d: Date, lang: 'en' | 'es', parts: 'day' | 'time' | 'short') {
  const loc = lang === 'es' ? 'es-MX' : 'en-US';
  if (parts === 'time') return d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit', timeZone: SHOP_TZ });
  if (parts === 'short') return d.toLocaleDateString(loc, { weekday: 'short', month: 'short', day: 'numeric', timeZone: SHOP_TZ });
  return d.toLocaleDateString(loc, { weekday: 'long', month: 'long', day: 'numeric', timeZone: SHOP_TZ });
}

/** Subject, plain text, HTML and a calendar invite for one appointment email. */
export function buildConfirmation(c: ConfirmationData) {
  const es = c.lang === 'es';
  const day = when(c.startsAt, c.lang, 'day');
  const range = `${when(c.startsAt, c.lang, 'time')} – ${when(c.endsAt, c.lang, 'time')}`;
  const shortWhen = `${when(c.startsAt, c.lang, 'short')}, ${when(c.startsAt, c.lang, 'time')}`;
  const services = [...new Set(c.services)].map((s) => SERVICES[c.lang][s] ?? s).join(', ');
  const hi = es ? `Hola${c.firstName ? ` ${c.firstName}` : ''},` : `Hi${c.firstName ? ` ${c.firstName}` : ''},`;

  const subject = {
    booked: es ? `Cita confirmada: ${shortWhen} · Da Spot 214` : `You're booked: ${shortWhen} · Da Spot 214`,
    moved: es ? `Nuevo horario: ${shortWhen} · Da Spot 214` : `New time: ${shortWhen} · Da Spot 214`,
    cancelled: es ? `Cita cancelada: ${shortWhen} · Da Spot 214` : `Appointment cancelled: ${shortWhen} · Da Spot 214`,
  }[c.kind];
  const lead = {
    booked: es ? 'Su cita en Da Spot 214 está confirmada.' : 'Your appointment at Da Spot 214 is confirmed.',
    moved: es ? 'Cambiamos su cita. Este es el nuevo horario:' : 'Your appointment has been moved. Here is the new time:',
    cancelled: es ? 'Su cita en Da Spot 214 fue cancelada.' : 'Your appointment at Da Spot 214 has been cancelled.',
  }[c.kind];

  const rows: [string, string][] = [
    [es ? 'Cuándo' : 'When', `${day}, ${range}`],
    ...(c.vehicle ? [[es ? 'Vehículo' : 'Vehicle', c.vehicle] as [string, string]] : []),
    ...(services ? [[es ? 'Servicio' : 'Service', services] as [string, string]] : []),
    ...(c.shop.address && c.kind !== 'cancelled' ? [[es ? 'Dónde' : 'Where', c.shop.address] as [string, string]] : []),
    [es ? 'Trabajo' : 'Job', `#${c.jobNumber}`],
  ];
  const contact = c.shop.phone
    ? (es ? `¿Necesita cambiar algo? Llame o envíe un texto al ${c.shop.phone}.` : `Need to change something? Call or text us at ${c.shop.phone}.`)
    : (es ? '¿Necesita cambiar algo? Responda a este correo.' : 'Need to change something? Just reply to this email.');
  const closing = c.kind === 'cancelled'
    ? (es ? '¿Quiere otro horario? Con gusto le agendamos de nuevo.' : 'Want a different time? We would be glad to book you again.')
    : (es ? 'El evento adjunto lo agrega a su calendario.' : 'The attached event adds it to your calendar.');

  const text = [hi, '', lead, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', closing, contact, '', 'Da Spot 214'].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#182024">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e1e8ea;border-radius:12px">
<tr><td style="padding:24px 24px 8px;font-size:22px;font-weight:700">Da Spot 214</td></tr>
<tr><td style="padding:8px 24px 0;font-size:16px;line-height:1.5">${esc(hi)}<br>${esc(lead)}</td></tr>
<tr><td style="padding:16px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;background:${c.kind === 'cancelled' ? '#fbeceb' : '#e3f0f5'};border-radius:8px">
<colgroup><col style="width:84px"><col></colgroup>
${rows.map(([k, v]) => `<tr><td style="padding:10px 0 0 14px;font-size:13px;color:#5e6e73;vertical-align:top">${esc(k)}</td><td style="padding:10px 14px 0;font-size:15px;font-weight:600">${esc(v)}</td></tr>`).join('\n')}
<tr><td colspan="2" style="height:10px"></td></tr></table></td></tr>
<tr><td style="padding:0 24px 24px;font-size:15px;line-height:1.5;color:#33414a">${esc(closing)}<br>${esc(contact)}</td></tr>
</table></td></tr></table></body></html>`;

  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Da Spot 214//Bookings//EN', `METHOD:${c.kind === 'cancelled' ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${c.appointmentId}@daspot214-client`,
    `SEQUENCE:${Math.floor(Date.now() / 1000) % 2147483647}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(c.startsAt)}`,
    `DTEND:${stamp(c.endsAt)}`,
    `SUMMARY:${icsEsc(`Da Spot 214${services ? ` · ${services}` : ''}`)}`,
    ...(c.shop.address ? [`LOCATION:${icsEsc(c.shop.address)}`] : []),
    `DESCRIPTION:${icsEsc(`${c.vehicle ? `${c.vehicle}\n` : ''}Job #${c.jobNumber}${c.shop.phone ? `\n${c.shop.phone}` : ''}`)}`,
    `STATUS:${c.kind === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');

  return { subject, text, html, ics };
}

export type EmailOutcome =
  | { status: 'sent'; to: string; live: boolean }
  | { status: 'no_email' }
  | { status: 'skipped' }
  | { status: 'failed'; to: string };

/**
 * Emails the client about their appointment, after the change has been saved. A failure never
 * undoes the booking; it leaves a task so the desk can reach the client another way.
 */
export async function sendAppointmentEmail(
  deps: { db: Queryable; email: EmailSender; shop: { phone?: string; address?: string } },
  appointmentId: string, kind: ConfirmationKind,
): Promise<EmailOutcome> {
  const { db, email } = deps;
  const a = (await db.query(
    `SELECT a.id, a.starts_at, a.ends_at, j.id AS job_id, j.number, c.first_name, c.email, c.language,
            v.year, v.make, v.model,
            ARRAY(SELECT li.service FROM job_line_items li WHERE li.job_id = j.id ORDER BY li.service) AS services
       FROM appointments a JOIN jobs j ON j.id = a.job_id JOIN contacts c ON c.id = j.contact_id
       LEFT JOIN vehicles v ON v.id = j.vehicle_id
      WHERE a.id = $1`, [appointmentId])).rows[0];
  if (!a) return { status: 'skipped' };
  if (!a.email) return { status: 'no_email' };
  const m = buildConfirmation({
    kind, lang: a.language === 'es' ? 'es' : 'en', firstName: a.first_name,
    startsAt: new Date(a.starts_at), endsAt: new Date(a.ends_at),
    vehicle: [a.year, a.make, a.model].filter(Boolean).join(' '), services: a.services,
    jobNumber: a.number, appointmentId: a.id, shop: deps.shop,
  });
  try {
    const sent = await email.send({
      to: a.email, subject: m.subject, text: m.text, html: m.html,
      attachments: [{ filename: kind === 'cancelled' ? 'cancelled.ics' : 'appointment.ics', content: m.ics, contentType: 'text/calendar' }],
    });
    await logActivity(db, 'job', a.job_id, 'email_sent', { kind, to: a.email, appointment_id: a.id, live: email.live, id: sent.id });
    return { status: 'sent', to: a.email, live: email.live };
  } catch (err) {
    console.error('appointment email failed', err);
    await logActivity(db, 'job', a.job_id, 'email_failed', { kind, to: a.email, appointment_id: a.id, error: String((err as Error).message) });
    await db.query(
      `INSERT INTO tasks (title, due_at, subject_type, subject_id, auto_rule) VALUES ($1, now(), 'job', $2, 'email_failed')`,
      [`The ${kind === 'booked' ? 'confirmation' : kind === 'moved' ? 'new-time' : 'cancellation'} email for job #${a.number} did not go out. Text or call the client.`, a.job_id]);
    return { status: 'failed', to: a.email };
  }
}
