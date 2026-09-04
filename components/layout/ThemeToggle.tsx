"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

/**
 * Light is the product's default, not the operating system's.
 *
 * The tokens already answer to `prefers-color-scheme`, so a person on a dark
 * desktop was handed a dark app they never asked for and had no way to leave.
 * Stamping `data-theme` on <html> beats that media query in both directions.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    // The inline script in the document head has already stamped the element
    // before first paint; read back from it rather than storage so the two can
    // never disagree.
    const stamped = document.documentElement.getAttribute("data-theme");
    setTheme(stamped === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("erp-theme", next);
    } catch {
      // Private windows and blocked site data throw here. The toggle still
      // works for this page; it just will not be remembered.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="theme-toggle"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light theme" : "Dark theme"}
    >
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
