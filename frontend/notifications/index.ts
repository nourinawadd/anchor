// frontend/notifications/index.ts
// Single home for everything notification-related on the client.
//
// Two mechanisms live here:
//   • Local notifications scheduled on-device (daily start nudge, in-session
//     Pomodoro phase alerts) — these fire even when the app is backgrounded or
//     killed, because the OS owns the schedule, not our JS timer.
//   • Push registration — obtains the Expo push token and hands it to the
//     backend, which sends the data-driven notifications (summary, streak, etc).
//
// NOTE: requires a dev-client rebuild to pull in the native expo-notifications
// module — a JS reload is not enough.

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { apiFetch } from '../api/client';

// Show the banner + play a sound even when the app is in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  true,
    shouldSetBadge:   false,
  }),
});

const PROJECT_ID =
  (Constants.expoConfig?.extra as any)?.eas?.projectId ??
  (Constants as any).easConfig?.projectId;

// ─── Push registration ────────────────────────────────────────────────────────
// Remembered so we can tell the backend to drop this token on sign-out.
let lastPushToken: string | null = null;

/**
 * Ask for permission (if not already granted), fetch the Expo push token, and
 * register it with the backend. Safe to call on every launch — it never
 * re-prompts once granted. Returns whether notifications are permitted.
 */
export async function registerForPush(): Promise<boolean> {
  // The simulator can't produce a push token; local notifications still work.
  if (!Device.isDevice) return false;

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return false;

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: PROJECT_ID });
    lastPushToken = token;
    // Backend may not have the endpoint yet (added in a later phase) or we may
    // be offline — local notifications are unaffected, so swallow failures.
    await apiFetch('/user/push-token', null, {
      method: 'POST',
      body:   JSON.stringify({ token }),
    });
  } catch (e) {
    console.warn('[notifications] push token registration failed', e);
  }
  return true;
}

/** Tell the backend to stop pushing to this device (called on sign-out). */
export async function unregisterPush(): Promise<void> {
  if (!lastPushToken) return;
  try {
    await apiFetch('/user/push-token', null, {
      method: 'DELETE',
      body:   JSON.stringify({ token: lastPushToken }),
    });
  } catch {
    /* best-effort — token will be pruned server-side when a push bounces */
  }
  lastPushToken = null;
}

// ─── Daily start nudge (legacy cleanup) ────────────────────────────────────────
// The nudge used to be a local repeating notification scheduled here, which
// fired blindly — a local trigger can't know whether the user already focused
// that day. It's now a backend-cron push (jobs/notificationCron.js) sent only
// when no session exists for the day. Devices that installed the old build may
// still carry the repeating notification, so cancel it once on launch.
const DAILY_NUDGE_ID = 'daily-start-nudge';

export async function cancelLegacyDailyNudge(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(DAILY_NUDGE_ID).catch(() => {});
}

// ─── In-session phase alerts (local, one-shot) ─────────────────────────────────
// Anchored to the phase's wall-clock deadline so the user is alerted to a
// break / resume / completion even with the app backgrounded. All ops are
// serialized through a single promise chain so a rapid cancel→schedule on a
// phase change can't race on `scheduledId`.
let scheduledId: string | null = null;
let opChain: Promise<void> = Promise.resolve();

function enqueue(fn: () => Promise<void>): Promise<void> {
  opChain = opChain.then(fn).catch(() => {});
  return opChain;
}

async function clearScheduled(): Promise<void> {
  if (scheduledId) {
    await Notifications.cancelScheduledNotificationAsync(scheduledId).catch(() => {});
    scheduledId = null;
  }
}

export function scheduleSessionAlert(date: Date, title: string, body: string): Promise<void> {
  return enqueue(async () => {
    await clearScheduled();
    // Skip deadlines in the past / about to pass — nothing useful to deliver.
    if (date.getTime() <= Date.now() + 500) return;
    scheduledId = await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
    });
  });
}

export function cancelSessionAlert(): Promise<void> {
  return enqueue(clearScheduled);
}
