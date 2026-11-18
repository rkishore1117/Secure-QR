import {
  ApplicationConfig,
  ErrorHandler,
  Injectable,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  NavigationError,
  provideRouter,
  withComponentInputBinding,
  withNavigationErrorHandler,
} from '@angular/router';
import {provideHttpClient, withFetch, withInterceptors} from '@angular/common/http';
import {routes} from './app.routes';
import {authInterceptor} from './core/interceptors/auth.interceptor';

function isChunkLoadFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    msg.includes('Loading chunk') ||
    msg.includes('ChunkLoadError')
  );
}

function reloadOnceForStaleChunk(targetUrl?: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const key = 'sqr_chunk_reload_at';
    const last = Number(window.sessionStorage.getItem(key) || '0');
    const now = Date.now();
    if (now - last < 10_000) {
      return false;
    }
    window.sessionStorage.setItem(key, String(now));
    if (targetUrl && targetUrl.startsWith('/')) {
      window.location.replace(window.location.origin + targetUrl);
    } else {
      window.location.reload();
    }
    return true;
  } catch {
    return false;
  }
}

@Injectable()
class ChunkRecoveryErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    if (isChunkLoadFailure(error) && reloadOnceForStaleChunk()) {
      return;
    }
    console.error(error);
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    {provide: ErrorHandler, useClass: ChunkRecoveryErrorHandler},
    provideRouter(
      routes,
      withComponentInputBinding(),
      withNavigationErrorHandler((navError: NavigationError) => {
        if (isChunkLoadFailure(navError.error)) {
          reloadOnceForStaleChunk(navError.url);
        }
      }),
    ),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
  ],
};
