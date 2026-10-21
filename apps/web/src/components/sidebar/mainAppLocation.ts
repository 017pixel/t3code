import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

let mainAppEntry: { href: string; historyIndex: number } | null = null;

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  const historyIndex = useLocation({ select: (location) => location.state.__TSR_index });
  useEffect(() => {
    if (href !== null) mainAppEntry = { href, historyIndex };
  }, [href, historyIndex]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  const router = useRouter();
  return () => {
    // Step back to the entry the utility page was opened from, so leaving it
    // doesn't push a duplicate that buries earlier main app history.
    const stepsBack = mainAppEntry
      ? router.history.location.state.__TSR_index - mainAppEntry.historyIndex
      : 0;
    if (stepsBack > 0) {
      router.history.go(-stepsBack);
      return;
    }
    void navigate({ href: mainAppEntry?.href ?? "/" });
  };
}
