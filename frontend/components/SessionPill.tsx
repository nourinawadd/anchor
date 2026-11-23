import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii, fontSize } from '../constants/theme';

/** What the live session reports to App for the pill. Sent only on changes. */
export type LiveSessionInfo = {
  name: string;
  label: 'Focus' | 'Break' | 'Paused' | 'Starting…' | 'Complete';
  /** Wall-clock end of the current countdown while it's ticking; null when frozen. */
  endsAtMs: number | null;
  /** Shown while frozen (paused / complete / starting). */
  frozenSecs: number;
};

function fmt(secs: number) {
  const s = Math.max(0, Math.round(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Floating "session in progress" pill shown on other screens while a session
 * runs in the background. Ticks itself from endsAtMs, so the session doesn't
 * have to report every second. Tapping returns to the session.
 */
export default function SessionPill({ info, onPress }: { info: LiveSessionInfo | null; onPress: () => void }) {
  const [, setTick] = useState(0);
  const ticking = info?.endsAtMs != null;

  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const secs = info?.endsAtMs != null
    ? (info.endsAtMs - Date.now()) / 1000
    : info?.frozenSecs ?? 0;
  const label = info?.label ?? 'Focus';
  const icon  = label === 'Break' ? 'cafe-outline'
    : label === 'Paused' ? 'pause'
    : label === 'Complete' ? 'checkmark'
    : 'timer-outline';

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.pill}
        onPress={onPress}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Return to session ${info?.name ?? ''}`}
      >
        <View style={styles.iconWrap}>
          <Ionicons name={icon} size={15} color={colors.white} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{info?.name ?? 'Session in progress'}</Text>
          <Text style={styles.label}>{label}</Text>
        </View>
        <Text style={styles.time}>{fmt(secs)}</Text>
        <Ionicons name="chevron-up" size={16} color="rgba(255,255,255,0.7)" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', left: 0, right: 0,
    bottom: Platform.OS === 'ios' ? 34 : 20,
    alignItems: 'center', paddingHorizontal: spacing.lg,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    width: '100%', maxWidth: 460,
    backgroundColor: colors.ink, borderRadius: radii.full,
    paddingVertical: spacing.sm + 2, paddingLeft: spacing.sm + 2, paddingRight: spacing.lg,
    shadowColor: colors.black, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22, shadowRadius: 14, elevation: 8,
  },
  iconWrap: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  name:  { fontSize: fontSize.sm, fontWeight: '700', color: colors.white },
  label: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.6)', marginTop: 1 },
  time:  { fontSize: fontSize.lg, fontWeight: '700', color: colors.white, fontVariant: ['tabular-nums'] },
});
