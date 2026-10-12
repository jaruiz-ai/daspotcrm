import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalizes a phone number to E.164. US is the default country.
 * Accepts Twilio's WhatsApp form ("whatsapp:+12145551234").
 * Returns null when the number is not valid.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^whatsapp:/i, '');
  const parsed = parsePhoneNumberFromString(cleaned, 'US');
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
