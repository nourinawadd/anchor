// frontend/utils/onboarding.ts
// Post-sign-in permission-priming onboarding chain. Each step explains a feature
// before triggering the OS permission dialog, and is shown at most once per
// device (an AsyncStorage "seen" flag — reinstalling re-runs the chain). The
// steps run in order (Screen Time → Calendar); nextOnboardingStep() returns the
// next not-yet-seen step (or null → fall through to Dashboard), and silently
// marks-as-seen any step that doesn't apply on this device (e.g. Screen Time
// off iOS).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isSupported as screenTimeSupported,
  getAuthorizationStatus as getScreenTimeAuthStatus,
} from 'anchor-screen-time';
import { isCalendarSupported } from './calendar';
import type { ScreenName } from '../App';

export const SCREEN_TIME_ONBOARDING_KEY = 'onboarding.screenTime.seen';
export const CALENDAR_ONBOARDING_KEY    = 'onboarding.calendar.seen';

const STEPS: { screen: ScreenName; key: string }[] = [
  { screen: 'OnboardingScreenTime', key: SCREEN_TIME_ONBOARDING_KEY },
  { screen: 'OnboardingCalendar',   key: CALENDAR_ONBOARDING_KEY },
];

export const markOnboardingSeen = (key: string) =>
  AsyncStorage.setItem(key, 'seen').catch(() => {});

// Steps that don't apply on this device are skipped (and marked seen) so the
// chain never dead-ends on a screen that can't do anything useful.
async function shouldSkip(screen: ScreenName): Promise<boolean> {
  if (screen === 'OnboardingScreenTime') {
    if (!screenTimeSupported()) return true;
    // iOS was already asked elsewhere (e.g. via Create Session) — no priming needed.
    return (await getScreenTimeAuthStatus()) !== 'notDetermined';
  }
  if (screen === 'OnboardingCalendar') return !isCalendarSupported();
  return false; // notifications priming is shown once on every platform
}

/**
 * The next onboarding step the user hasn't seen yet, or null when the chain is
 * done. Pass the step you're leaving as `after` to resume from the next one.
 */
export async function nextOnboardingStep(after?: ScreenName): Promise<ScreenName | null> {
  const start = after ? STEPS.findIndex(s => s.screen === after) + 1 : 0;
  for (let i = start; i < STEPS.length; i++) {
    const { screen, key } = STEPS[i];
    if (await AsyncStorage.getItem(key)) continue;
    if (await shouldSkip(screen)) { await markOnboardingSeen(key); continue; }
    return screen;
  }
  return null;
}
