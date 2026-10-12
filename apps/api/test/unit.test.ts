import { describe, expect, it } from 'vitest';
import { parseLead } from '../src/lib/leadParser.js';
import { computeTotals } from '../src/lib/money.js';
import { canMove, needsFrontSideWaiver } from '../src/lib/stages.js';
import { toE164 } from '../src/lib/phone.js';
import { isValidTwilioSignature, twilioSignature, autoReplyText } from '../src/lib/messaging.js';

const NOW = new Date('2026-10-12T12:00:00Z');

describe('parseLead', () => {
  it('reads an English quote request', () => {
    const p = parseLead('hey how much for 20% on a 2022 camry all windows', NOW);
    expect(p).toMatchObject({ language: 'en', year: 2022, make: 'Toyota', model: 'Camry', shade_vlt: 20 });
    expect(p.services).toEqual(['full_tint']);
  });

  it('reads a Spanish request with "al 15"', () => {
    const p = parseLead('cuanto por polarizar mi silverado 2019 al 15', NOW);
    expect(p).toMatchObject({ language: 'es', year: 2019, make: 'Chevrolet', model: 'Silverado', shade_vlt: 15 });
  });

  it('does not mistake the year for a shade', () => {
    const p = parseLead('2015 civic fronts', NOW);
    expect(p.year).toBe(2015);
    expect(p.shade_vlt).toBeNull();
    expect(p.services).toEqual(['front_two']);
  });

  it('handles 2-digit years and multi-word models', () => {
    expect(parseLead("'19 grand cherokee windshield", NOW)).toMatchObject({ year: 2019, make: 'Jeep', model: 'Grand Cherokee' });
    expect(parseLead('tesla model y pano roof', NOW)).toMatchObject({ make: 'Tesla', model: 'Model Y', services: ['pano_roof'] });
  });

  it('rejects impossible years and shades', () => {
    const p = parseLead('my 2099 truck 33%', NOW);
    expect(p.year).toBeNull();
    expect(p.shade_vlt).toBeNull();
  });

  it('flags flat glass and removal', () => {
    expect(parseLead('need tint for my house windows', NOW).services).toContain('flat_glass');
    expect(parseLead('old tint is purple and bubbling', NOW).services).toEqual(['removal']);
  });

  it('returns nothing useful for small talk', () => {
    expect(parseLead('hello?', NOW)).toMatchObject({ make: null, year: null, services: [], shade_vlt: null });
  });
});

describe('computeTotals', () => {
  it('applies Dallas sales tax after discount, rounded to the cent', () => {
    expect(computeTotals(30000, 2000, 825, 0)).toMatchObject({ tax_cents: 2310, total_cents: 30310, balance_cents: 30310 });
  });
  it('never taxes a negative amount', () => {
    expect(computeTotals(1000, 5000, 825, 0)).toMatchObject({ tax_cents: 0, total_cents: 0 });
  });
});

describe('stage rules', () => {
  it('never allows Paid by hand', () => {
    expect(canMove('completed', 'paid')).toBe(false);
    expect(canMove('new_lead', 'completed')).toBe(false);
    expect(canMove('lost', 'new_lead')).toBe(true);
  });

  it('requires a waiver only for dark front sides', () => {
    expect(needsFrontSideWaiver([{ service: 'full_tint', windows: [], shade_vlt: 20 }])).toBe(true);
    expect(needsFrontSideWaiver([{ service: 'full_tint', windows: [], shade_vlt: 35 }])).toBe(false);
    expect(needsFrontSideWaiver([{ service: 'full_tint', windows: ['rear_sides', 'back_glass'], shade_vlt: 5 }])).toBe(false);
    expect(needsFrontSideWaiver([{ service: 'other', windows: ['front_left'], shade_vlt: 15 }])).toBe(true);
    expect(needsFrontSideWaiver([{ service: 'windshield', windows: [], shade_vlt: 70 }])).toBe(false);
  });
});

describe('phones', () => {
  it('normalizes US formats and WhatsApp addresses', () => {
    expect(toE164('(214) 555-0199')).toBe('+12145550199');
    expect(toE164('whatsapp:+12145550199')).toBe('+12145550199');
    expect(toE164('214.555.0199')).toBe('+12145550199');
    expect(toE164('+52 55 1234 5678')).toBe('+525512345678');
    expect(toE164('123')).toBeNull();
    expect(toE164('')).toBeNull();
  });
});

describe('twilio signatures', () => {
  // Example from Twilio's docs.
  const token = '12345';
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  it('matches Twilio\'s published example', () => {
    expect(twilioSignature(token, url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
  it('rejects tampered params and missing headers', () => {
    const sig = twilioSignature(token, url, params);
    expect(isValidTwilioSignature(token, url, params, sig)).toBe(true);
    expect(isValidTwilioSignature(token, url, { ...params, Digits: '9999' }, sig)).toBe(false);
    expect(isValidTwilioSignature(token, url, params, undefined)).toBe(false);
  });
});

describe('auto-reply text', () => {
  it('asks only for what is missing, in the customer\'s language', () => {
    expect(autoReplyText('en', [])).not.toMatch(/send us/);
    expect(autoReplyText('es', ['vehicle'])).toMatch(/año, marca y modelo/);
  });
});
