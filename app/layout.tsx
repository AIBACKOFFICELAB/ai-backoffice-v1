import type { Metadata, Viewport } from "next";
import "./globals.css";
import { display, body as bodyFont } from "./fonts";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.aibackoffice.app"),
  title: {
    default: "AI BackOffice — Never lose a job to a missed call",
    template: "%s · AI BackOffice",
  },
  description:
    "AI BackOffice answers missed calls, chases unsigned estimates, and requests reviews automatically — so a two-person crew runs its front office like it has a full-time dispatcher.",
  openGraph: {
    title: "AI BackOffice — Never lose a job to a missed call",
    description:
      "Automated missed-call recovery, estimate follow-up, and review requests for home service contractors.",
    url: "https://www.aibackoffice.app",
    siteName: "AI BackOffice",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI BackOffice — Never lose a job to a missed call",
    description:
      "Automated missed-call recovery, estimate follow-up, and review requests for home service contractors.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b1633",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${bodyFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}
