// Responsive helpers for tablet / iPad support.
//
// Two distinct concerns, deliberately kept separate:
//   • LAYOUT decisions key off the *current window width* (reactive, via
//     useWindowDimensions) — an iPad in 1/3 Split View is ~320pt wide and
//     should render the compact phone layout, not the centered tablet one.
//   • FEATURE availability (e.g. NFC hardware, build flags) keys off the
//     *device class* (Platform.isPad), which never changes at runtime.
import { useWindowDimensions, Platform } from 'react-native';

/** Window width (pt) at/above which we treat the layout as "tablet-wide". */
export const WIDE_BREAKPOINT = 600;

/** Cap for the centered single-column content on wide screens. */
export const CONTENT_MAX_WIDTH = 600;

/** Device class — iPads have no NFC hardware and need the native iPad build. */
export const isPadDevice = Platform.OS === 'ios' && Platform.isPad;

export type Responsive = {
  width: number;
  height: number;
  /** Window is wide enough to center + cap the content column. */
  isWide: boolean;
  isLandscape: boolean;
  /** Static device-class flag (NOT layout) — true on every iPad. */
  isPad: boolean;
  /** Max content width to use right now: capped when wide, full width otherwise. */
  contentMaxWidth: number;
  /**
   * Extra horizontal padding (pt) to add on each side so the content column
   * stays centered at CONTENT_MAX_WIDTH on wide screens. 0 below the cap, so
   * adding it to a screen's base padding is a no-op on phones.
   *
   *   contentContainerStyle={[styles.container, { paddingHorizontal: BASE + sidePadding }]}
   */
  sidePadding: number;
};

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT;
  return {
    width,
    height,
    isWide,
    isLandscape: width > height,
    isPad: isPadDevice,
    contentMaxWidth: isWide ? CONTENT_MAX_WIDTH : width,
    sidePadding: Math.max(0, (width - CONTENT_MAX_WIDTH) / 2),
  };
}
