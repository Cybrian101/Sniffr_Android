/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      "colors": {
        "primary": "#F4A7B9", // Petal Pink
        "on-primary": "#ffffff",
        "primary-container": "#FEE4E9",
        "on-primary-container": "#915064",
        "primary-fixed": "#FEE4E9",
        "primary-fixed-dim": "#FFD1DC",
        "secondary": "#A8D8EA", // Sky Blue
        "on-secondary": "#ffffff",
        "secondary-container": "#D1EEFB",
        "on-secondary-container": "#2D5A72",
        "secondary-fixed": "#D1EEFB",
        "secondary-fixed-dim": "#A8D8EA",
        "tertiary": "#8FD4C1", // Mint
        "on-tertiary": "#ffffff",
        "tertiary-container": "#D5F2E9",
        "on-tertiary-container": "#2A5D50",
        "tertiary-fixed": "#D5F2E9",
        "tertiary-fixed-dim": "#B8E6D9",
        "background": "#F7F9FC",
        "on-background": "#453F41",
        "surface": "#F7F9FC",
        "on-surface": "#453F41",
        "surface-variant": "#EBF2F6",
        "on-surface-variant": "#71686B",
        "surface-container-lowest": "#ffffff",
        "surface-container-low": "#F1F5F9",
        "surface-container": "#F0F4F8",
        "surface-container-high": "#E5F0F5",
        "surface-container-highest": "#EAF1F5",
        "outline": "#D1C4C9",
        "outline-variant": "#E9DDE1",
        "error": "#ba1a1a",
        "error-container": "#ffdad6",
        "on-error": "#ffffff",
        "on-error-container": "#93000a",
      },
      "borderRadius": {
        "DEFAULT": "1rem",
        "lg": "2rem",
        "xl": "3rem",
        "full": "9999px"
      },
      "fontFamily": {
        "headline": ["Plus Jakarta Sans", "sans-serif"],
        "body": ["Plus Jakarta Sans", "sans-serif"],
        "label": ["Plus Jakarta Sans", "sans-serif"]
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries')
  ],
}
