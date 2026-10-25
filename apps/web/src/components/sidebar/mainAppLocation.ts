import { useNavigate, type AnyRouter } from "@tanstack/react-router";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

// Pages the root route renders without the app shell, so they are never the app to return to.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent"]);

let mainAppHref: string | null = null;

/** Remembers the last app location outside utility pages, for their way back. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname, href } = router.state.location;
    if (isSidebarUtilityPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    mainAppHref = href;
  };
  record();
  return router.subscribe("onResolved", record);
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}
