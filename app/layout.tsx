import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";

export const metadata: Metadata = {
  title: {
    default: "marketing.erp.io",
    template: "%s — marketing.erp.io",
  },
  description: "48 AI marketing agents. One operator. You.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://marketing.erp.io"),
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <SessionProvider session={session}>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
