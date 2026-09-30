import type { Metadata } from "next";
import "./globals.css";
// Shared suite chrome. Relative rather than the @erp-ui alias: tsconfig paths
// are resolved for module imports, not guaranteed for the CSS pipeline.
import "../vendor/erp-ui/erp-ui.css";
import { StaleBuildReloader } from "@erp-ui";
import { SessionProvider } from "next-auth/react";

export const metadata: Metadata = {
  /*
   * The suffix lives here and ONLY here. Every page under this layout used to
   * restate "— marketing.erp.io" in its own title string, which the template
   * then appended a second time, so every tab in the app read
   * "Agents — marketing.erp.io — marketing.erp.io". Page titles are now the
   * page's name alone; this is what turns it into the full one.
   */
  title: {
    default: "Marketing ERP | ERP.io",
    template: "%s | Marketing ERP | ERP.io",
  },
  description: "AI marketing agents that plan, write, publish and report — run from one workspace.",
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
        {/* Above the route groups so a tab left open across a deploy
            recovers on every page, sign-in and error pages included. */}
        <StaleBuildReloader />
        <SessionProvider>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
