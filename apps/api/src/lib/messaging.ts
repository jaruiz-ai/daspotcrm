import crypto from 'node:crypto';

export type Channel = 'sms' | 'whatsapp';

export interface OutboundMessage {
  to: string; // E.164
  channel: Channel;
  body: string;
}

export interface MessageSender {
  send(msg: OutboundMessage): Promise<{ externalId: string | null }>;
}

/** Sends through Twilio's Messages API. WhatsApp uses the "whatsapp:" address prefix. */
export class TwilioSender implements MessageSender {
  constructor(
    private accountSid: string,
    private authToken: string,
    private smsFrom: string,
    private whatsappFrom: string,
  ) {}

  async send({ to, channel, body }: OutboundMessage) {
    const from = channel === 'whatsapp' ? `whatsapp:${this.whatsappFrom}` : this.smsFrom;
    const toAddr = channel === 'whatsapp' ? `whatsapp:${to}` : to;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: toAddr, Body: body }),
    });
    if (!res.ok) throw new Error(`Twilio send failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { sid?: string };
    return { externalId: json.sid ?? null };
  }
}

/** Records sends in memory. Used in tests and local dev when Twilio isn't configured. */
export class FakeSender implements MessageSender {
  sent: OutboundMessage[] = [];
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    return { externalId: `fake-${this.sent.length}` };
  }
}

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function isValidTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const MISSING_PROMPTS = {
  en: { vehicle: 'the year, make and model', service: 'which windows or service you want' },
  es: { vehicle: 'el año, marca y modelo', service: 'qué ventanas o servicio quiere' },
};

export function autoReplyText(lang: 'en' | 'es', missing: ('vehicle' | 'service')[]): string {
  const asks = missing.map((m) => MISSING_PROMPTS[lang][m]);
  if (lang === 'es') {
    const base = '¡Gracias por escribir a Da Spot 214! Le respondemos en unos minutos con su precio.';
    return asks.length ? `${base} Para cotizar, mándenos ${asks.join(' y ')}.` : base;
  }
  const base = 'Thanks for texting Da Spot 214! We\'ll get back to you with pricing in a few minutes.';
  return asks.length ? `${base} To quote you, send us ${asks.join(' and ')}.` : base;
}
