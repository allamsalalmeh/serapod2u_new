'use client'

import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'light' | 'dark'
type ThemeVariant = 'default' | 'slate' | 'ocean' | 'forest' | 'purple' | 'sunset' | 'black' | 'nord'

interface ThemeContextType {
  theme: Theme
  setTheme: (theme: Theme) => void
  resolvedTheme: 'light' | 'dark'
  themeVariant: ThemeVariant
  setThemeVariant: (variant: ThemeVariant) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize from localStorage to prevent flash of wrong theme
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const savedTheme = localStorage.getItem('theme')
      // Migrate 'system' to 'light' if previously saved
      if (savedTheme === 'system' || !savedTheme) return 'light'
      if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme
      return 'light'
    }
    return 'light'
  })
  
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')
  
  const [themeVariant, setThemeVariantState] = useState<ThemeVariant>(() => {
    if (typeof window !== 'undefined') {
      const savedVariant = localStorage.getItem('themeVariant') as ThemeVariant | null
      return savedVariant || 'default'
    }
    return 'default'
  })

  useEffect(() => {
    // Apply theme to document
    const root = document.documentElement
    
    const effectiveTheme: 'light' | 'dark' = theme
    
    setResolvedTheme(effectiveTheme)
    
    // Remove all theme classes first
    root.classList.remove('light', 'dark', 'theme-slate', 'theme-ocean', 'theme-forest', 'theme-purple', 'theme-sunset', 'theme-black', 'theme-nord')
    
    // Set data-theme attribute for CSS custom property targeting
    root.setAttribute('data-theme', effectiveTheme)
    
    // Add the effective theme class
    if (effectiveTheme === 'dark' && themeVariant === 'default') {
      root.classList.add('dark')
    } else if (themeVariant !== 'default') {
      root.classList.add(`theme-${themeVariant}`)
    } else {
      root.classList.add(effectiveTheme)
    }
    
    // Save to localStorage
    localStorage.setItem('theme', theme)
  }, [theme, themeVariant])

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme)
  }

  const setThemeVariant = (variant: ThemeVariant) => {
    setThemeVariantState(variant)
    localStorage.setItem('themeVariant', variant)
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme, themeVariant, setThemeVariant }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
