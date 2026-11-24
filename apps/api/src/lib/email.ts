/** Outbound email. Resend in production; a recorder in tests and the test site. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}

export interface EmailSender {
  /** True when mail actually leaves the building (shown to staff so the test site never pretends). */
  readonly live: boolean;
  send(m: EmailMessage): Promise<{ id: string }>;
}

/** Resend's HTTP API (https://resend.com). FROM must be on a domain verified in Resend. */
export class ResendSender implements EmailSender {
  readonly live = true;
  constructor(private apiKey: string, private from: string, private replyTo?: string) {}
  async send(m: EmailMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [m.to],
        reply_to: this.replyTo || undefined,
        subject: m.subject,
        text: m.text,
        html: m.html,
        attachments: m.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content).toString('base64'),
          content_type: a.contentType,
        })),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(body as any)?.message ?? 'send failed'}`);
    return { id: String((body as any).id ?? '') };
  }
}

/** Keeps every email in memory instead of sending it. */
export class FakeEmailSender implements EmailSender {
  readonly live = false;
  sent: EmailMessage[] = [];
  failNext = false;
  async send(m: EmailMessage) {
    if (this.failNext) { this.failNext = false; throw new Error('simulated email failure'); }
    this.sent.push(m);
    return { id: `fake-${this.sent.length}` };
  }
}
