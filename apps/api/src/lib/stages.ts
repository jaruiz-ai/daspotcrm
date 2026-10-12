export const STAGES = ['new_lead', 'quoted', 'booked', 'in_bay', 'completed', 'paid', 'lost'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Manual moves staff can make on the pipeline board.
 * 'paid' is never set by hand: it is reached only when payments clear the balance.
 */
export const MANUAL_TRANSITIONS: Record<Stage, Stage[]> = {
  new_lead: ['quoted', 'lost'],
  quoted: ['new_lead', 'booked', 'lost'],
  booked: ['quoted', 'in_bay', 'lost'],
  in_bay: ['booked', 'completed'],
  completed: ['in_bay'],
  paid: [],
  lost: ['new_lead'],
};

export function canMove(from: Stage, to: Stage): boolean {
  return MANUAL_TRANSITIONS[from].includes(to);
}

/** Texas: front side windows must let through at least 25% of light. */
export const TX_FRONT_SIDE_MIN_VLT = 25;
const FRONT_SIDE_SERVICES = new Set(['full_tint', 'front_two']);
const FRONT_SIDE_WINDOWS = new Set(['front_left', 'front_right', 'front_sides']);

export interface LineForCompliance {
  service: string;
  windows: string[];
  shade_vlt: number | null;
}

/** True when any line puts film darker than the legal limit on a front side window. */
export function needsFrontSideWaiver(lines: LineForCompliance[]): boolean {
  return lines.some((l) => {
    if (l.shade_vlt == null || l.shade_vlt >= TX_FRONT_SIDE_MIN_VLT) return false;
    if (l.windows.some((w) => FRONT_SIDE_WINDOWS.has(w))) return true;
    // A full tint or front-two line with no window list covers the front sides.
    return FRONT_SIDE_SERVICES.has(l.service) && l.windows.length === 0;
  });
}
