/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // SENTROID — "Trust & Authority": security blue primary
        brand: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0369a1', // primary
          700: '#075985',
          800: '#0c4a6e',
          900: '#082f49',
          950: '#052338',
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
        sans: ['"Source Sans 3"', 'system-ui', 'sans-serif'],
        display: ['Lexend', 'system-ui', 'sans-serif'],
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
