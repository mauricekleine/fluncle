module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  plugins: [],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      borderRadius: {
        artwork: "6px",
        lg: "10px",
        md: "8px",
        sm: "6px",
      },

      colors: {
        background: "#090a0b",
        border: "rgba(208, 185, 144, 0.161)",
        "deep-field": "#090a0b",
        destructive: "#ff6b57",
        "dust-line": "rgba(208, 185, 144, 0.161)",
        "dust-veil": "rgba(208, 185, 144, 0.102)",
        "eclipse-glow": "#ffd057",
        "eclipse-gold": "#f5b800",
        foreground: "#f4ead7",
        "gold-veil": "rgba(245, 184, 0, 0.102)",
        "ink-on-gold": "#151006",
        muted: "#b7ab95",
        primary: "#f5b800",
        "primary-foreground": "#151006",
        "reentry-red": "#ff6b57",
        "rule-dark": "#3a342a",
        "sleeve-black": "#10100d",
        stardust: "#b7ab95",
        "starlight-cream": "#f4ead7",
        "tape-black": "#171611",
      },

      fontFamily: {
        body: ["SpaceGrotesk_400Regular"],
        display: ["Oxanium_800ExtraBold"],
        label: ["SpaceGrotesk_700Bold"],
        numeric: ["Oxanium_400Regular"],
        title: ["SpaceGrotesk_700Bold"],
      },
    },
  },
};
