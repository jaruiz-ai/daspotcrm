import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { nextPhone, setup } from './helpers.js';
import { twilioSignature } from '../src/lib/messaging.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

let sid = 0;
const inbound = (from: string, body: string, extra: Record<string, string> = {}) =>
  request(ctx.app).post('/webhooks/twilio/inbound').type('form')
    .send({ From: from, To: '+14695550000', Body: body, MessageSid: `SM${++sid}`, ...extra });

const contactByPhone = async (mobile: string) =>
  (await ctx.db.query('SELECT * FROM contacts WHERE mobile = $1', [mobile])).rows[0];
const jobsFor = async (contactId: string) =>
  (await ctx.db.query('SELECT * FROM jobs WHERE contact_id = $1 ORDER BY created_at', [contactId])).rows;

describe('inbound text → lead', () => {
  it('creates a contact, vehicle and New lead job from a first text, and auto-replies', async () => {
    const mobile = nextPhone();
    const before = ctx.sender.sent.length;
    const res = await inbound(mobile, 'hey how much for 20% on a 2022 camry all windows');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');

    const c = await contactByPhone(mobile);
    expect(c).toMatchObject({ language: 'en', preferred_channel: 'sms', lead_source: 'sms' });
    const [job] = await jobsFor(c.id);
    expect(job.stage).toBe('new_lead');
    const v = (await ctx.db.query('SELECT * FROM vehicles WHERE id = $1', [job.vehicle_id])).rows[0];
    expect(v).toMatchObject({ year: 2022, make: 'Toyota', model: 'Camry' });

    const reply = ctx.sender.sent.slice(before);
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({ to: mobile, channel: 'sms' });
    expect(reply[0].body).not.toMatch(/send us/); // nothing missing
    const out = await ctx.db.query(`SELECT * FROM messages WHERE contact_id = $1 AND direction = 'out'`, [c.id]);
    expect(out.rows).toHaveLength(1);
  });

  it('handles WhatsApp in Spanish and asks for what is missing', async () => {
    const mobile = nextPhone();
    const before = ctx.sender.sent.length;
    await inbound(`whatsapp:${mobile}`, 'hola cuanto cuesta polarizar?');
    const c = await contactByPhone(mobile);
    expect(c).toMatchObject({ language: 'es', preferred_channel: 'whatsapp' });
    const reply = ctx.sender.sent.slice(before)[0];
    expect(reply.channel).toBe('whatsapp');
    expect(reply.body).toMatch(/año, marca y modelo/);
  });

  it('is idempotent when Twilio retries the same message', async () => {
    const mobile = nextPhone();
    const before = ctx.sender.sent.length;
    const body = { From: mobile, Body: '2019 tahoe fronts', MessageSid: 'SM-retry-1' };
    await request(ctx.app).post('/webhooks/twilio/inbound').type('form').send(body);
    await request(ctx.app).post('/webhooks/twilio/inbound').type('form').send(body);
    const c = await contactByPhone(mobile);
    expect(await jobsFor(c.id)).toHaveLength(1);
    expect((await ctx.db.query(`SELECT * FROM messages WHERE contact_id = $1 AND direction = 'in'`, [c.id])).rows).toHaveLength(1);
    expect(ctx.sender.sent.length - before).toBe(1);
  });

  it('attaches follow-up texts to the open job instead of opening new ones', async () => {
    const mobile = nextPhone();
    await inbound(mobile, '2021 civic full tint');
    await inbound(mobile, 'also how much for windshield?', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/1' });
    const c = await contactByPhone(mobile);
    const jobs = await jobsFor(c.id);
    expect(jobs).toHaveLength(1);
    const msgs = (await ctx.db.query(`SELECT * FROM messages WHERE contact_id = $1 AND direction = 'in' ORDER BY created_at`, [c.id])).rows;
    expect(msgs.every((m: any) => m.job_id === jobs[0].id)).toBe(true);
    expect(msgs[1].media_urls).toEqual(['https://api.twilio.com/media/1']);
  });

  it('opens a new job when a past customer asks about another car, but not for small talk', async () => {
    const mobile = nextPhone();
    await inbound(mobile, '2018 f150 full tint');
    const c = await contactByPhone(mobile);
    await ctx.db.query(`UPDATE jobs SET stage = 'lost', lost_reason = 'other' WHERE contact_id = $1`, [c.id]);

    await inbound(mobile, 'thanks again!');
    expect(await jobsFor(c.id)).toHaveLength(1);
    const task = await ctx.db.query(`SELECT * FROM tasks WHERE subject_id = $1 AND auto_rule = 'returning_customer_message'`, [c.id]);
    expect(task.rows).toHaveLength(1);

    await inbound(mobile, 'want to do my wifes 2023 rav4 too');
    const jobs = await jobsFor(c.id);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].stage).toBe('new_lead');
  });

  it('does not attach a car to a house job', async () => {
    const mobile = nextPhone();
    await inbound(mobile, 'can you tint my house? got a 2020 tahoe too lol');
    const c = await contactByPhone(mobile);
    const [job] = await jobsFor(c.id);
    expect(job.vehicle_id).toBeNull();
  });

  it('honors STOP without auto-replying, and START to opt back in', async () => {
    const mobile = nextPhone();
    const before = ctx.sender.sent.length;
    await inbound(mobile, 'STOP');
    expect((await contactByPhone(mobile)).sms_opt_in).toBe(false);
    expect(ctx.sender.sent.length).toBe(before);
    expect(await jobsFor((await contactByPhone(mobile)).id)).toHaveLength(0);
    await inbound(mobile, 'start');
    expect((await contactByPhone(mobile)).sms_opt_in).toBe(true);
  });

  it('switches the reply channel to whatever the customer used last', async () => {
    const mobile = nextPhone();
    await inbound(mobile, 'hi 2020 camry tint');
    await inbound(`whatsapp:${mobile}`, 'texting you here instead');
    const c = await contactByPhone(mobile);
    expect(c.preferred_channel).toBe('whatsapp');
    // Same person, one contact.
    expect((await ctx.db.query('SELECT COUNT(*)::int AS n FROM contacts WHERE mobile = $1', [mobile])).rows[0].n).toBe(1);
  });

  it('rejects junk sender numbers', async () => {
    expect((await inbound('not-a-number', 'hi')).status).toBe(400);
  });

  it('still records the lead and creates a task when the auto-reply fails to send', async () => {
    const mobile = nextPhone();
    const orig = ctx.sender.send.bind(ctx.sender);
    ctx.sender.send = async () => { throw new Error('Twilio down'); };
    const res = await inbound(mobile, '2022 camry tint');
    ctx.sender.send = orig;
    expect(res.status).toBe(200);
    const c = await contactByPhone(mobile);
    expect(await jobsFor(c.id)).toHaveLength(1);
    const t = await ctx.db.query(`SELECT * FROM tasks WHERE subject_id = $1 AND auto_rule = 'auto_reply_failed'`, [c.id]);
    expect(t.rows).toHaveLength(1);
  });
});

describe('webhook signature checks', () => {
  it('accepts a correctly signed request and rejects forged ones', async () => {
    const signed = await setup({ twilioAuthToken: 'secret', publicBaseUrl: 'https://crm.example.com' });
    const params = { From: nextPhone(), To: '+14695550000', Body: 'hi', MessageSid: 'SMsig1' };
    const sig = twilioSignature('secret', 'https://crm.example.com/webhooks/twilio/inbound', params);
    const ok = await request(signed.app).post('/webhooks/twilio/inbound').type('form').set('x-twilio-signature', sig).send(params);
    expect(ok.status).toBe(200);
    const forged = await request(signed.app).post('/webhooks/twilio/inbound').type('form').set('x-twilio-signature', sig)
      .send({ ...params, Body: 'changed' });
    expect(forged.status).toBe(403);
    const unsigned = await request(signed.app).post('/webhooks/twilio/inbound').type('form').send(params);
    expect(unsigned.status).toBe(403);
  });
});
