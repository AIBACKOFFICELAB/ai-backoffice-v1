import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        brand: {
          50: "#eef2fc",
          100: "#dbe4f8",
          200: "#b3c6f0",
          300: "#88a5e6",
          400: "#5c7fd9",
          500: "#3a5fc7",
          600: "#2748ab",
          700: "#1f3a8a",
          800: "#1a2f6e",
          900: "#16265a",
          950: "#0b1633",
        },
        gold: {
          50: "#fbf6ea",
          100: "#f3e6c2",
          200: "#e6cd8a",
          300: "#d6b256",
          400: "#c39a34",
          500: "#a67f24",
          600: "#84631a",
        },
        surface: {
          DEFAULT: "#f6f6f8",
          raised: "#ffffff",
          sunken: "#eceef1",
          border: "#e1e3e8",
        },
        ink: {
          900: "#12141a",
          700: "#31333d",
          500: "#5b5e6b",
          400: "#80838f",
        },
        // Semantic status tokens (P1B) — single source of truth so
        // "success"/"warning"/"danger" stop being ad hoc emerald-600 /
        // amber-100 / red-600 utility strings copy-pasted per page.
        success: {
          50: "#ecfdf5",
          100: "#d1fae5",
          600: "#059669",
          700: "#047857",
        },
        warning: {
          50: "#fffbeb",
          100: "#fef3c7",
          600: "#d97706",
          700: "#b45309",
        },
        danger: {
          50: "#fef2f2",
          100: "#fee2e2",
          600: "#dc2626",
          700: "#b91c1c",
        },
      },
      borderRadius: {
        card: "14px",
        control: "10px",
        pill: "999px",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(15 23 42 / 0.04)",
        card: "0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 1px 0 rgb(15 23 42 / 0.03)",
        raised: "0 4px 16px -4px rgb(15 23 42 / 0.10), 0 1px 2px 0 rgb(15 23 42 / 0.04)",
        floating: "0 24px 48px -12px rgb(15 23 42 / 0.22), 0 4px 12px -2px rgb(15 23 42 / 0.08)",
      },
      maxWidth: {
        page: "1180px",
        prose: "72ch",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
