import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "next-auth/react";

export const metadata: Metadata = {
  title: {
    default: "marketing.erp.io",
    template: "%s — marketing.erp.io",
  },
  description: "48 AI marketing agents. One operator. You.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://app.erp.io/marketing"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Stamp the theme before first paint.
          The tokens answer to `prefers-color-scheme`, so without this a person
          on a dark desktop gets a dark app they never chose. Light is the
          product default; only an explicit stored choice changes it. Inline and
          blocking on purpose — deferring it means a visible flash of the wrong
          theme on every navigation.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('erp-theme');document.documentElement.setAttribute('data-theme',t==='dark'?'dark':'light')}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`,
          }}
        />
      </head>
      <body>
        <SessionProvider>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
