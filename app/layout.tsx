import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Backoffice",
  description: "Generated backoffice app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <main className="mx-auto max-w-5xl p-6">{children}</main>
      </body>
    </html>
  );
}
