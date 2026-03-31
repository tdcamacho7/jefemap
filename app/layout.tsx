import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JefeMap — GEX Heatmap",
  description: "Real-time Gamma Exposure heatmap",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#080b12' }}>{children}</body>
    </html>
  );
}
