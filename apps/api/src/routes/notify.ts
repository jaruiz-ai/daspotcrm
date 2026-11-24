import type { Deps } from '../app.js';
import { sendAppointmentEmail, type ConfirmationKind } from '../lib/confirmation.js';

/** Emails the client about an appointment change, unless the caller asked not to. */
export const appointmentMailer = ({ db, email, config }: Deps) =>
  (appointmentId: string, kind: ConfirmationKind, notify = true) =>
    notify
      ? sendAppointmentEmail({ db, email: email!, shop: { phone: config.shopPhone, address: config.shopAddress, logoUrl: config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/$/, '')}/logo-email.png` : config.logoUrl } }, appointmentId, kind)
      : Promise.resolve({ status: 'skipped' as const });
