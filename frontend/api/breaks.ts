// frontend/api/breaks.ts
// Custom Breaks endpoints (Countdown sessions). Screens call these — never
// apiFetch directly — so error handling stays in one place.
//
// Contract (proposed for the backend; mirrored by api/mockBreaks.ts):
//   POST /sessions/:id/breaks/start
//     body: { type: 'PLANNED', plannedIndex } | { type: 'ON_DEMAND', duration }
//   POST /sessions/:id/breaks/end
//     body: {}
//   Both return the session's break state (SessionBreakState fields).
//   Errors carry a machine-readable `code` (see BreakErrorCode).

import { apiFetch } from './client';
import { normalizeBreakState, RawBreakState, SessionBreakState } from '../store/sessions';

export const ON_DEMAND_MIN_MINUTES = 1;
export const ON_DEMAND_MAX_MINUTES = 60;

export type StartBreakRequest =
  | { type: 'PLANNED'; plannedIndex: number }
  | { type: 'ON_DEMAND'; duration: number };   // minutes, 1–60

export type BreakErrorCode =
  | 'ALLOWANCE_EXCEEDED'    // on-demand break over the allowance (or no allowance)
  | 'BREAK_ALREADY_OPEN'    // a break is already in progress
  | 'PLANNED_BREAK_TAKEN'   // this planned break was already used
  | 'SESSION_NOT_ACTIVE'    // session already ended (or doesn't exist)
  | 'NO_OPEN_BREAK'         // ending a break when none is in progress
  | 'INVALID_BREAK'         // bad request: unknown plannedIndex, length out of range
  | 'NETWORK'               // couldn't reach the server
  | 'UNKNOWN';

const MESSAGES: Record<BreakErrorCode, string> = {
  ALLOWANCE_EXCEEDED:  "You've used up your on-demand breaks for this session.",
  BREAK_ALREADY_OPEN:  "You're already on a break.",
  PLANNED_BREAK_TAKEN: "You've already taken this planned break.",
  SESSION_NOT_ACTIVE:  'This session has already ended.',
  NO_OPEN_BREAK:       "There's no break in progress to end.",
  INVALID_BREAK:       "That break isn't valid for this session.",
  NETWORK:             "Couldn't reach the server. Check your connection and try again.",
  UNKNOWN:             'Something went wrong with your break. Please try again.',
};

const KNOWN_CODES = new Set<string>(Object.keys(MESSAGES));

export class BreakError extends Error {
  readonly code: BreakErrorCode;
  readonly status: number | null;
  constructor(code: BreakErrorCode, message?: string, status: number | null = null) {
    super(message || MESSAGES[code]);
    this.name   = 'BreakError';
    this.code   = code;
    this.status = status;
  }
}

/** Translate whatever apiFetch threw into a BreakError with a clear code. */
function toBreakError(err: any): BreakError {
  if (err instanceof BreakError) return err;
  const status: number | null = typeof err?.status === 'number' ? err.status : null;
  if (status === null) return new BreakError('NETWORK');   // apiFetch throws status-less on network failure
  if (typeof err?.code === 'string' && KNOWN_CODES.has(err.code)) {
    return new BreakError(err.code as BreakErrorCode, err.message, status);
  }
  if (status === 404) return new BreakError('SESSION_NOT_ACTIVE', undefined, status);
  if (status === 400) return new BreakError('INVALID_BREAK', undefined, status);
  return new BreakError('UNKNOWN', undefined, status);
}

/** Client-side validation, so obviously bad requests fail fast and offline. */
function validate(req: StartBreakRequest): void {
  if (req.type === 'PLANNED') {
    if (!Number.isInteger(req.plannedIndex) || req.plannedIndex < 0) {
      throw new BreakError('INVALID_BREAK', 'Unknown planned break.');
    }
    return;
  }
  if (
    !Number.isInteger(req.duration) ||
    req.duration < ON_DEMAND_MIN_MINUTES ||
    req.duration > ON_DEMAND_MAX_MINUTES
  ) {
    throw new BreakError(
      'INVALID_BREAK',
      `Breaks must be ${ON_DEMAND_MIN_MINUTES}–${ON_DEMAND_MAX_MINUTES} whole minutes.`,
    );
  }
}

export async function startBreak(
  sessionId: string,
  req: StartBreakRequest,
  token: string | null = null,
): Promise<SessionBreakState> {
  validate(req);
  const body = req.type === 'PLANNED'
    ? { type: 'PLANNED',   plannedIndex: req.plannedIndex }
    : { type: 'ON_DEMAND', duration:     req.duration };
  try {
    const raw = await apiFetch<RawBreakState>(`/sessions/${sessionId}/breaks/start`, token, {
      method: 'POST',
      body:   JSON.stringify(body),
    });
    return normalizeBreakState(raw);
  } catch (err) {
    throw toBreakError(err);
  }
}

export async function endBreak(
  sessionId: string,
  token: string | null = null,
): Promise<SessionBreakState> {
  try {
    const raw = await apiFetch<RawBreakState>(`/sessions/${sessionId}/breaks/end`, token, {
      method: 'POST',
      body:   JSON.stringify({}),
    });
    return normalizeBreakState(raw);
  } catch (err) {
    throw toBreakError(err);
  }
}
