import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors } from '../constants/theme';

/**
 * Fixed decorative layer that sits behind a screen's ScrollView so the frosted
 * glass cards have something to refract. Non-interactive and non-scrolling:
 * content scrolls over it. Uses only existing theme colours (Twilight Indigo +
 * Pale Slate over the app background).
 */
export default function GlassBackdrop() {
  return (
    <View style={styles.root} pointerEvents="none">
      <View style={styles.indigoCircle} />
      <View style={styles.slateCircleLeft} />
      <View style={styles.indigoRing} />
      <View style={styles.slateCircleBottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  // Filled Twilight Indigo circle, upper-right.
  indigoCircle: {
    position: 'absolute', top: 64, right: -56,
    width: 180, height: 180, borderRadius: 90,
    backgroundColor: colors.ink, opacity: 0.16,
  },
  // Filled Pale Slate circle, left-middle.
  slateCircleLeft: {
    position: 'absolute', top: '36%', left: -130,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: colors.mutedLight, opacity: 0.45,
  },
  // Indigo ring, right-middle.
  indigoRing: {
    position: 'absolute', top: '48%', right: -64,
    width: 170, height: 170, borderRadius: 85,
    borderWidth: 16, borderColor: colors.ink, opacity: 0.14,
  },
  // Filled Pale Slate circle, bottom-right.
  slateCircleBottom: {
    position: 'absolute', bottom: -72, right: -44,
    width: 200, height: 200, borderRadius: 100,
    backgroundColor: colors.mutedLight, opacity: 0.4,
  },
});
