import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import Matches from '@/pages/matches';
import Settings from '@/pages/settings';
import Login from '@/pages/login';
import { useGetCurrentUser, useLogout, getGetCurrentUserQueryKey } from '@workspace/api-client-react';
import { LogOut, Loader2, ListChecks, Settings as SettingsIcon } from 'lucide-react';
import {
  Route,
  Switch,
  Link,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function AppRoutes() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Matches} />
        <Route path="/matches" component={Matches} />
        <Route path="/search" component={Home} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function NavBar() {
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const logout = useLogout();

  const linkClass = (path: string) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
      location === path ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
    }`;
  const isHome = location === '/' || location === '/matches';

  return (
    <header className="border-b bg-background sticky top-0 z-10">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-1">
          <Link
            href="/"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              isHome ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            <ListChecks className="h-4 w-4" /> 검색 결과
          </Link>
          <Link href="/settings" className={linkClass('/settings')}>
            <SettingsIcon className="h-4 w-4" /> 설정
          </Link>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            logout.mutate(undefined, {
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
              },
            })
          }
        >
          <LogOut className="h-4 w-4" /> 로그아웃
        </Button>
      </div>
    </header>
  );
}

function AuthGate() {
  const queryClient = useQueryClient();
  const currentUser = useGetCurrentUser();

  if (currentUser.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> 확인 중...
      </div>
    );
  }

  if (!currentUser.data?.authenticated) {
    return (
      <Login
        onLoggedIn={() => {
          void queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        }}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <NavBar />
      <AppRoutes />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthGate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
