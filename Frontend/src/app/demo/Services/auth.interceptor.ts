import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { throwError, BehaviorSubject } from 'rxjs';
import { catchError, switchMap, filter, take } from 'rxjs/operators';
import { AuthService } from './auth.service';

let isRefreshing = false;
let refreshTokenSubject: BehaviorSubject<string | null> = new BehaviorSubject<string | null>(null);

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  
  // 1. CRITICAL: Bypass all auth requests (login, signup, refresh)
  // We do NOT want to append expired tokens or intercept 401s on auth endpoints
  if (req.url.includes('/api/auth/')) {
    return next(req);
  }

  // Get raw token snapshot safely
  let token = authService.currentUser();
  
  // Sanitize sneaky stringified local storage values
  if (token === 'null' || token === 'undefined' || !token) {
    token = null;
  }

  // 2. Attach the token to the outgoing non-auth request
  let authReq = req;
  if (token) {
    authReq = req.clone({
      setHeaders: { Authorization: `Bearer ${token}` }
    });
  }

  // 3. Handle responses and capture 401 errors
  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      
      // If unauthorized, and we have a token that just expired, initiate rotation
      if (error.status === 401 && token) {
        if (!isRefreshing) {
          isRefreshing = true;
          refreshTokenSubject.next(null);

          return authService.refreshToken().pipe(
            switchMap((res: any) => {
              isRefreshing = false;
              
              // Emit the brand new token to all waiting parallel streams
              const newToken = res.token;
              refreshTokenSubject.next(newToken);
              
              // Retry the original stalled request with the shiny new token
              return next(req.clone({
                setHeaders: { Authorization: `Bearer ${newToken}` }
              }));
            }),
            catchError((err) => {
              isRefreshing = false;
              authService.logout(); // Refresh token also expired; force login kick out
              return throwError(() => err);
            })
          );
        } else {
          // Parallel Requests Queue: If rotation is already active, halt here and wait
          return refreshTokenSubject.pipe(
            filter(newToken => newToken !== null),
            take(1),
            switchMap((newToken) => {
              // Retry with the new token once the leader process broadcasts it
              return next(req.clone({
                setHeaders: { Authorization: `Bearer ${newToken}` }
              }));
            })
          );
        }
      }
      
      // Return any non-401 errors straight to the application layout handlers
      return throwError(() => error);
    })
  );
};