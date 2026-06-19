// frontend/screens/OnboardingCalendarScreen.tsx
// Permission-priming step, shown once per device after sign-in (iOS only):
// explains WHY Anchor wants Calendar access *before* triggering iOS's system
// permission dialog, which is easier to grant with context. Mirrors
// OnboardingScreenTimeScreen so the onboarding steps feel like one flow.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NavProps } from '../App';
import { requestCalendarPermission, setCalendarSyncEnabled } from '../utils/calendar';
import {
  CALENDAR_ONBOARDING_KEY,
  markOnboardingSeen,
  nextOnboardingStep,
} from '../utils/onboarding';

export { CALENDAR_ONBOARDING_KEY };

export default function OnboardingCalendarScreen({ nav }: { nav: NavProps }) {
  const [busy,   setBusy]   = useState(false);
  const [denied, setDenied] = useState(false);

  const markSeen = () => markOnboardingSeen(CALENDAR_ONBOARDING_KEY);

  const finish = async () => {
    await markSeen();
    const next = await nextOnboardingStep('OnboardingCalendar');
    nav.replace(next ?? 'Dashboard');
  };

  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const granted = await requestCalendarPermission();
      if (granted) {
        await setCalendarSyncEnabled(true);
        await finish();
        return;
      }
      // Denied. The OS won't re-prompt, so show the Settings hint and let them
      // continue; calendar sync stays off and can be enabled later in Settings.
      await markSeen();
      setDenied(true);
    } catch {
      await markSeen();
      setDenied(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Ionicons name="calendar-outline" size={44} color="#fff" />
        </View>

        <Text style={styles.title}>Plan around{'\n'}your day</Text>
        <Text style={styles.body}>
          With calendar access, Anchor shows your day's events on the dashboard
          and logs each completed session to a dedicated “Anchor” calendar — so
          your focus time lives alongside everything else.
        </Text>
        <Text style={styles.body}>
          iOS will ask you to allow <Text style={styles.bold}>Calendar access</Text>.
          Anchor only reads today's events and writes its own sessions — nothing else.
        </Text>

        {denied && (
          <Text style={styles.deniedNote}>
            No problem — you can turn calendar sync on anytime from Settings.
          </Text>
        )}
      </View>

      <View style={styles.footer}>
        {denied ? (
          <TouchableOpacity style={styles.button} onPress={finish}>
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.button, busy && styles.buttonDisabled]}
              onPress={handleEnable}
              disabled={busy}
            >
              <Text style={styles.buttonText}>{busy ? 'Waiting for iOS…' : 'Connect Calendar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={finish} disabled={busy}>
              <Text style={styles.skipText}>Maybe later</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen:         { flex: 1, backgroundColor: '#fff', padding: 28, paddingTop: Platform.OS === 'ios' ? 70 : 50 },
  content:        { flex: 1, justifyContent: 'center', alignItems: 'center' },
  iconCircle:     {
    width: 96, height: 96, borderRadius: 48, backgroundColor: '#313852',
    alignItems: 'center', justifyContent: 'center', marginBottom: 32,
  },
  title:          { fontSize: 28, fontWeight: 'bold', color: '#313852', textAlign: 'center', marginBottom: 16, lineHeight: 34 },
  body:           { fontSize: 15, color: '#2F2F2F', textAlign: 'center', lineHeight: 22, marginBottom: 14, maxWidth: 320 },
  bold:           { fontWeight: '600', color: '#313852' },
  deniedNote:     {
    fontSize: 13, color: '#2F2F2F', textAlign: 'center', lineHeight: 19,
    backgroundColor: '#C3CAD4', borderRadius: 10, padding: 12, marginTop: 6, maxWidth: 320,
  },
  footer:         { paddingBottom: 24 },
  button:         { backgroundColor: '#313852', borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginBottom: 14 },
  buttonDisabled: { opacity: 0.6 },
  buttonText:     { color: '#fff', fontSize: 16, fontWeight: '600' },
  skipText:       { textAlign: 'center', fontSize: 14, color: '#2F2F2F', paddingVertical: 6 },
});
