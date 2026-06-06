import React, { createContext, useContext } from 'react';
import { ColorPalette, getColors, lightColors } from '../constants/theme';

// ─── Context ─────────────────────────────────────────────────────────────────
type ThemeContextValue = {
  colors: ColorPalette;
  dark:   boolean;
};

const ThemeContext = createContext<ThemeContextValue>({
  colors: lightColors,
  dark:   false,
});

// ─── Provider ─────────────────────────────────────────────────────────────────
export function ThemeProvider({
  dark,
  children,
}: {
  dark:     boolean;
  children: React.ReactNode;
}) {
  return (
    <ThemeContext.Provider value={{ colors: getColors(dark), dark }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
