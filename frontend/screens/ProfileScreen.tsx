import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform } from 'react-native';
import { NavProps } from '../App';
import { ColorPalette } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { computeFocusHours, computeLongestStreak } from '../store/sessions';

export default function ProfileScreen({ nav }: { nav: NavProps }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { user, sessions } = nav;
  const initial = user.name.charAt(0).toUpperCase();

  const totalSessions  = sessions.length;
  const focusHours     = computeFocusHours(sessions);
  const longestStreak  = computeLongestStreak(sessions);

  const memberSince = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '—';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.menuBtn} onPress={nav.openDrawer}>
          <View style={styles.menuLine} />
          <View style={styles.menuLine} />
          <View style={styles.menuLine} />
        </TouchableOpacity>
        <Text style={styles.title}>Profile</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Avatar */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <Text style={styles.name}>{user.name}</Text>
        {user.email ? <Text style={styles.email}>{user.email}</Text> : null}
      </View>

      {/* Info Cards */}
      <Text style={styles.sectionLabel}>ACCOUNT INFO</Text>

      <View style={styles.card}>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Full Name</Text>
          <Text style={styles.infoValue}>{user.name}</Text>
        </View>
        <View style={styles.rowDivider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Email</Text>
          <Text style={styles.infoValue}>{user.email || '—'}</Text>
        </View>
        <View style={styles.rowDivider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Member Since</Text>
          <Text style={styles.infoValue}>{memberSince}</Text>
        </View>
      </View>

      {/* Stats */}
      <Text style={styles.sectionLabel}>MY STATS</Text>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{totalSessions}</Text>
          <Text style={styles.statLabel}>Sessions</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{focusHours}h</Text>
          <Text style={styles.statLabel}>Total Focus</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{longestStreak}d</Text>
          <Text style={styles.statLabel}>Best Streak</Text>
        </View>
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutBtn} onPress={nav.signOut}>
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>

    </ScrollView>
  );
}

const makeStyles = (c: ColorPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  container: { padding: 20, paddingTop: Platform.OS === 'ios' ? 60 : 44, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 },
  menuBtn: { width: 40, height: 40, justifyContent: 'center' },
  menuLine: { width: 22, height: 2.5, backgroundColor: c.ink, borderRadius: 2, marginBottom: 5 },
  title: { fontSize: 20, fontWeight: '700', color: c.ink },
  headerSpacer: { width: 40 },
  avatarSection: { alignItems: 'center', marginBottom: 30 },
  avatar: {
    width: 82, height: 82, borderRadius: 41,
    backgroundColor: c.ink, justifyContent: 'center',
    alignItems: 'center', marginBottom: 14,
  },
  avatarText: { color: c.bg, fontSize: 32, fontWeight: '700' },
  name: { fontSize: 22, fontWeight: '700', color: c.ink, marginBottom: 4 },
  email: { fontSize: 14, color: c.muted },
  sectionLabel: {
    fontSize: 11, fontWeight: '600', color: c.muted,
    letterSpacing: 1.2, marginBottom: 10, marginTop: 4,
  },
  card: { backgroundColor: c.card, borderRadius: 14, marginBottom: 20, overflow: 'hidden' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  rowDivider: { height: 1, backgroundColor: c.border, marginHorizontal: 16 },
  infoLabel: { fontSize: 14, color: c.muted, fontWeight: '500' },
  infoValue: { fontSize: 14, color: c.ink, fontWeight: '600' },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 24 },
  statCard: { flex: 1, backgroundColor: c.card, borderRadius: 14, padding: 16, alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: 'bold', color: c.ink, marginBottom: 2 },
  statLabel: { fontSize: 11, color: c.muted, textAlign: 'center' },
  logoutBtn: {
    borderRadius: 14, paddingVertical: 16, alignItems: 'center',
    borderWidth: 1.5, borderColor: c.danger, backgroundColor: c.card,
  },
  logoutText: { color: c.danger, fontSize: 16, fontWeight: '600' },
});
