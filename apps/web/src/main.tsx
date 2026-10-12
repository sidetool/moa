import { installPlaybackFullscreen } from "./lib/playback-fullscreen";
import { installRemoteNavigation } from "./lib/remote";
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useNavigate, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell";
import { GenrePage, HomePage } from "./pages/HomePage";
import { PlayRedirect, TitlePage } from "./pages/TitlePage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { HistoryPage, MePage, MyListPage, SearchPage } from "./pages/ListPages";
import { SettingsPage } from "./pages/AdminPages";
import { SourceBrowsePage } from "./pages/SourcesPage";
import { WatchPage } from "./pages/WatchPage";
import { ShortsPage } from "./pages/ShortsPage";
import { useMe } from "./api/queries";
import { EmptyState } from "./components/ui";
import { ApiError, currentProfileId } from "./lib/api";
import type { MediaType } from "@moa/shared";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/player.css";
import "./styles/shorts.css";

if (import.meta.env.VITE_MOCK === "1") {
  const { installMockApi } = await import("./api/mock");
  installMockApi();
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500), refetchOnWindowFocus: false }
  }
});

/** Every app route needs a chosen profile; the server also enforces it. */
function RequireProfile({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    const onRequired = () => navigate("/profiles", { replace: true });
    window.addEventListener("moa:profile-required", onRequired);
    return () => window.removeEventListener("moa:profile-required", onRequired);
  }, [navigate]);
  return currentProfileId() ? <>{children}</> : <Navigate to="/profiles" replace />;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return null;
  return me.data?.role === "admin" ? <>{children}</> : <div className="page-pad narrow"><EmptyState title="관리자만 볼 수 있어요" body="이 페이지는 관리자만 사용할 수 있어요." /></div>;
}

function GenreRoute({ type }: { type?: MediaType }) {
  const { genre = "" } = useParams();
  return <GenrePage type={type} genre={decodeURIComponent(genre)} />;
}

const router = createBrowserRouter([
  { path: "/profiles", element: <ProfilesPage /> },
  { path: "/watch/:episodeId", element: <RequireProfile><WatchPage /></RequireProfile> },
  { path: "/play/:id", element: <RequireProfile><PlayRedirect /></RequireProfile> },
  {
    element: <RequireProfile><AppShell /></RequireProfile>,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/series", element: <Navigate to="/tabs/series" replace /> },
      { path: "/movies", element: <Navigate to="/tabs/movies" replace /> },
      { path: "/anime", element: <Navigate to="/tabs/anime" replace /> },
      { path: "/tabs/:tabId", element: <HomePage /> },
      { path: "/local", element: <HomePage localOnly /> },
      { path: "/local/genre/:genre", element: <GenreRoute /> },
      { path: "/series/genre/:genre", element: <GenreRoute type="series" /> },
      { path: "/movies/genre/:genre", element: <GenreRoute type="movie" /> },
      { path: "/anime/genre/:genre", element: <GenreRoute type="anime" /> },
      { path: "/title/:id", element: <TitlePage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/my-list", element: <MyListPage /> },
      { path: "/shorts", element: <ShortsPage /> },
      { path: "/history", element: <HistoryPage /> },
      { path: "/sources", element: <RequireAdmin><Navigate to="/settings#sources" replace /></RequireAdmin> },
      { path: "/sources/:id", element: <SourceBrowsePage /> },
      { path: "/library", element: <RequireAdmin><Navigate to="/settings#library" replace /></RequireAdmin> },
      { path: "/plugins", element: <RequireAdmin><Navigate to="/settings#plugins" replace /></RequireAdmin> },
      { path: "/subtitles", element: <RequireAdmin><Navigate to="/settings#subtitle-library" replace /></RequireAdmin> },
      { path: "/remote-access", element: <RequireAdmin><Navigate to="/settings#remote-access" replace /></RequireAdmin> },
      { path: "/accounts", element: <RequireAdmin><Navigate to="/settings#accounts" replace /></RequireAdmin> },
      { path: "/about", element: <Navigate to="/settings#about" replace /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/settings/tabs", element: <Navigate to="/settings#tabs" replace /> },
      { path: "/me", element: <MePage /> },
      { path: "*", element: <Navigate to="/" replace /> }
    ]
  }
]);

const disposeRemote = installRemoteNavigation(router);
const disposeFullscreen = installPlaybackFullscreen(router);
if (import.meta.hot) import.meta.hot.dispose(() => { disposeRemote(); disposeFullscreen(); });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
