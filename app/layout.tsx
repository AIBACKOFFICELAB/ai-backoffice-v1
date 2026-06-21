import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

// Enable dynamic rendering since AppShell checks auth state which requires cookies
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "AI BackOffice",
  description: "Contractor growth platform demo",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
