import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "next-auth/react";

export const metadata: Metadata = {
  title: {
    default: "marketing.erp.io",
    template: "%s — marketing.erp.io",
  },
  description: "48 AI marketing agents. One operator. You.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://marketing.erp.io"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <SessionProvider>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
