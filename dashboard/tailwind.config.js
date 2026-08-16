/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Override just the dark end of Tailwind's default `slate` scale —
        // every page already uses dark:bg-slate-900 / dark:border-slate-800
        // for cards/surfaces, so tuning these three shades fixes elevation
        // and contrast app-wide without touching individual components.
        // Default slate-900/800 (#0f172a / #1e293b) sit too close in
        // luminance to read as distinct layers; this widens the gap
        // (page < card < border), GitHub-dark-style.
        slate: {
          950: '#0a0d12',
          900: '#161a21',
          800: '#2a2f3a',
        },
        // SENTROID — modern indigo primary (security-grade trust, AI-console feel)
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5', // primary
          700: '#4338ca',
          800: '#372f9e',
          900: '#312e81',
          950: '#1e1b4b',
        },
        // Accent — "protected" green (CTA / success / online)
        accent: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        },
        // Neutral canvas — cool, blue-tinted greys for the light UI
        canvas: {
          50: '#f8fbfe',
          100: '#f0f6fb',
          200: '#e6eef6',
          300: '#d6e2ee',
        },
      },
      fontFamily: {
        // One typeface for the whole app — weight/size carries the hierarchy
        // instead of mixing in a second "branded" display font.
        sans: ['"Source Sans 3"', 'system-ui', 'sans-serif'],
        display: ['"Source Sans 3"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(12,74,110,0.04), 0 4px 16px -6px rgba(12,74,110,0.10)',
        'card-hover': '0 2px 4px rgba(3,105,161,0.06), 0 12px 28px -10px rgba(3,105,161,0.20)',
        focus: '0 0 0 3px rgba(3,105,161,0.18)',
      },
    },
  },
  plugins: [],
};
