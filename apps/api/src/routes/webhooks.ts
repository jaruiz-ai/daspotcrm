import { Router } from 'express';
import type { Deps } from '../app.js';
import type { Queryable } from '../db/index.js';
import { HttpError } from '../lib/errors.js';
import { parseLead } from '../lib/leadParser.js';
import { autoReplyText, isValidTwilioSignature, type Channel } from '../lib/messaging.js';
import { toE164 } from '../lib/phone.js';
import { logActivity } from './shared.js';

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|baja|alto)\s*$/i;
const START_WORDS = /^\s*(start|unstop|yes)\s*$/i;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export interface InboundResult {
  contactId: string;
  jobId: string | null;
  isNewContact: boolean;
  duplicate: boolean;
  autoReply: { to: string; channel: Channel; body: string } | null;
}

/**
 * Inbound SMS/WhatsApp → contact + lead. Exported for tests.
 * Runs in one transaction; idempotent on Twilio's MessageSid so retries don't double-create.
 */
export async function handleInbound(q: Queryable, p: Record<string, string>): Promise<InboundResult> {
  const channel: Channel = /^whatsapp:/i.test(p.From ?? '') ? 'whatsapp' : 'sms';
  const mobile = toE164(p.From);
  if (!mobile) throw new HttpError(400, 'bad_from', 'Sender number is not valid');
  const body = (p.Body ?? '').slice(0, 4000);
  const sid = p.MessageSid || p.SmsSid || null;
  const media: string[] = [];
  const numMedia = Math.min(Number(p.NumMedia) || 0, 10);
  for (let i = 0; i < numMedia; i++) if (p[`MediaUrl${i}`]) media.push(p[`MediaUrl${i}`]);

  if (sid) {
    const dup = await q.query('SELECT contact_id, job_id FROM messages WHERE external_id = $1', [sid]);
    if (dup.rows[0]) {
      return { contactId: dup.rows[0].contact_id, jobId: dup.rows[0].job_id, isNewContact: false, duplicate: true, autoReply: null };
    }
  }

  const parsed = parseLead(body);

  // Upsert by phone so two quick messages from a new number can't create two contacts.
  const inserted = await q.query(
    `INSERT INTO contacts (mobile, language, preferred_channel, lead_source)
     VALUES ($1,$2,$3,$4) ON CONFLICT (mobile) DO NOTHING RETURNING *`,
    [mobile, parsed.language, channel, channel],
  );
  const isNewContact = inserted.rows.length > 0;
  const contact = isNewContact
    ? inserted.rows[0]
    : (await q.query('SELECT * FROM contacts WHERE mobile = $1 FOR UPDATE', [mobile])).rows[0];

  // Opt-out / opt-in keywords: record and stop. Twilio also enforces STOP for SMS.
  if (STOP_WORDS.test(body) || START_WORDS.test(body)) {
    const optIn = START_WORDS.test(body);
    await q.query('UPDATE contacts SET sms_opt_in = $2, updated_at = now() WHERE id = $1', [contact.id, optIn]);
    await q.query(
      `INSERT INTO messages (contact_id, channel, direction, body, media_urls, external_id) VALUES ($1,$2,'in',$3,$4,$5)`,
      [contact.id, channel, body, media, sid]);
    return { contactId: contact.id, jobId: null, isNewContact, duplicate: false, autoReply: null };
  }

  if (!isNewContact && contact.preferred_channel !== channel) {
    // Reply on whatever they last used.
    await q.query('UPDATE contacts SET preferred_channel = $2, updated_at = now() WHERE id = $1', [contact.id, channel]);
  }

  let jobId: string | null = null;
  const looksLikeRequest = !!(parsed.make || parsed.services.length);
  if (!isNewContact) {
    const open = await q.query(
      `SELECT id FROM jobs WHERE contact_id = $1 AND stage NOT IN ('paid','lost') ORDER BY updated_at DESC LIMIT 1`,
      [contact.id]);
    jobId = open.rows[0]?.id ?? null;
  }

  if (!jobId && (isNewContact || looksLikeRequest)) {
    let vehicleId: string | null = null;
    if (parsed.make || parsed.year) {
      // Reuse a vehicle they already have on file if it matches.
      const existing = await q.query(
        `SELECT id FROM vehicles WHERE contact_id = $1 AND make IS NOT DISTINCT FROM $2
            AND model IS NOT DISTINCT FROM $3 AND year IS NOT DISTINCT FROM $4 LIMIT 1`,
        [contact.id, parsed.make, parsed.model, parsed.year]);
      vehicleId = existing.rows[0]?.id ?? (await q.query(
        `INSERT INTO vehicles (contact_id, year, make, model) VALUES ($1,$2,$3,$4) RETURNING id`,
        [contact.id, parsed.year, parsed.make, parsed.model])).rows[0].id;
    }
    const isFlatGlass = parsed.services.includes('flat_glass');
    jobId = (await q.query(
      `INSERT INTO jobs (contact_id, vehicle_id, lead_source) VALUES ($1,$2,$3) RETURNING id`,
      [contact.id, isFlatGlass ? null : vehicleId, channel])).rows[0].id;
    await logActivity(q, 'job', jobId!, 'created', { via: channel, parsed });
    const summary = [
      parsed.year || parsed.make ? `Vehicle: ${[parsed.year, parsed.make, parsed.model].filter(Boolean).join(' ')}` : null,
      parsed.services.length ? `Services: ${parsed.services.join(', ')}` : null,
      parsed.shade_vlt ? `Shade asked: ${parsed.shade_vlt}%` : null,
      `Language: ${parsed.language === 'es' ? 'Spanish' : 'English'}`,
    ].filter(Boolean).join(' · ');
    await q.query(`INSERT INTO notes (subject_type, subject_id, type, body, pinned) VALUES ('job', $1, 'text', $2, true)`,
      [jobId, `Auto-read from first ${channel === 'whatsapp' ? 'WhatsApp' : 'text'}: ${summary}`]);
    await q.query(
      `INSERT INTO tasks (title, due_at, subject_type, subject_id, auto_rule)
       VALUES ($1, now() + interval '15 minutes', 'job', $2, 'new_lead_reply')`,
      [`Quote new ${channel === 'whatsapp' ? 'WhatsApp' : 'text'} lead ${mobile}`, jobId]);
  } else if (!jobId) {
    await q.query(
      `INSERT INTO tasks (title, due_at, subject_type, subject_id, auto_rule)
       VALUES ($1, now() + interval '1 hour', 'contact', $2, 'returning_customer_message')`,
      [`Reply to returning customer ${mobile}`, contact.id]);
  }

  await q.query(
    `INSERT INTO messages (contact_id, job_id, channel, direction, body, media_urls, external_id)
     VALUES ($1,$2,$3,'in',$4,$5,$6)`,
    [contact.id, jobId, channel, body, media, sid]);
  await q.query('UPDATE contacts SET updated_at = now() WHERE id = $1', [contact.id]);

  let autoReply: InboundResult['autoReply'] = null;
  if (isNewContact && contact.sms_opt_in) {
    const missing: ('vehicle' | 'service')[] = [];
    if (!parsed.make && !parsed.services.includes('flat_glass')) missing.push('vehicle');
    if (!parsed.services.length) missing.push('service');
    autoReply = { to: mobile, channel, body: autoReplyText(parsed.language, missing) };
  }
  return { contactId: contact.id, jobId, isNewContact, duplicate: false, autoReply };
}

export function webhooksRouter({ db, sender, config }: Deps) {
  const r = Router();

  r.post('/twilio/inbound', async (req, res) => {
    const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
    if (config.twilioAuthToken) {
      const url = config.publicBaseUrl.replace(/\/$/, '') + req.originalUrl;
      if (!isValidTwilioSignature(config.twilioAuthToken, url, params, req.get('x-twilio-signature'))) {
        return res.status(403).type('text/plain').send('Invalid signature');
      }
    }
    const result = await db.tx((q) => handleInbound(q, params));

    // Send after commit; a failed send must not make Twilio retry and duplicate the lead.
    if (result.autoReply) {
      try {
        const sent = await sender.send(result.autoReply);
        await db.query(
          `INSERT INTO messages (contact_id, job_id, channel, direction, body, external_id) VALUES ($1,$2,$3,'out',$4,$5)`,
          [result.contactId, result.jobId, result.autoReply.channel, result.autoReply.body, sent.externalId]);
      } catch (err) {
        console.error('auto-reply failed', err);
        await db.query(
          `INSERT INTO tasks (title, due_at, subject_type, subject_id, auto_rule)
           VALUES ('Auto-reply failed — text this lead manually', now(), 'contact', $1, 'auto_reply_failed')`,
          [result.contactId]);
      }
    }
    res.type('text/xml').send(EMPTY_TWIML);
  });

  return r;
}
