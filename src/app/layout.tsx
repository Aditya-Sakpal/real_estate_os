import type { Metadata, Viewport } from "next";
import { Figtree, Instrument_Serif } from "next/font/google";
import "./globals.css";
import "./mobile.css";
import "./mobile/work.css";
import "./mobile/leads.css";
import "./mobile/campaigns.css";
import "./mobile/partners-settings.css";

// Geometric sans with a double-storey 'a', matching the reference lettering.
const sans = Figtree({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

// The single italic-serif emphasis word per heading -- the references' signature.
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: "italic",
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sales Desk",
  description: "Sales and marketing autopilot for Indian real estate.",
};

// viewport-fit=cover lets a page read the notch and the home bar's insets,
// which the tab bar and every sheet pad themselves by.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#eeeff2",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
