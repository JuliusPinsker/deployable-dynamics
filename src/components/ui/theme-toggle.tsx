import React, { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export default function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const current = resolvedTheme || theme || "system";

  // Avoid hydration mismatch — render a placeholder until mounted
  if (!mounted) {
    return (
      <Button size="icon" variant="ghost" aria-label="Toggle color theme">
        <Sun className="h-4 w-4 opacity-0" />
      </Button>
    );
  }

  const isDark = current === "dark";

  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
