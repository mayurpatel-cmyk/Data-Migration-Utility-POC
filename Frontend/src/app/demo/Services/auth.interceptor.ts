import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { throwError, BehaviorSubject } from 'rxjs';
import { catchError, switchMap, filter, take } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { environment } from 'src/environments/environment';

let isRefreshing = false;
let refreshTokenSubject: BehaviorSubject<string | null> = new BehaviorSubject<string | null>(null);

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);

  const isOwnApi = req.url.startsWith(environment.apiUrl);
  if (!isOwnApi) {
    return next(req);
  }

  // 1. STRICT BYPASS: Only ignore actual Supabase login/signup routes
  const isPublicAuthRoute = req.url.endsWith('/api/auth/login') ||
                            req.url.endsWith('/api/auth/signup') ||
                            req.url.endsWith('/api/auth/refresh');

  if (isPublicAuthRoute) {
    return next(req);
  }

  // 2. GET TOKEN safely
  let token = authService.currentUser();
  if (token === 'null' || token === 'undefined' || !token) {
    token = null;
  }

  // 3. ATTACH TOKEN
  let authReq = req;
  if (token) {
    authReq = req.clone({
      setHeaders: { Authorization: `Bearer ${token}` }
    });
  }

  // 4. HANDLE RESPONSES
  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401 && token) {
        if (!isRefreshing) {
          isRefreshing = true;
          refreshTokenSubject.next(null);

          return authService.refreshToken().pipe(
            switchMap((res: any) => {
              isRefreshing = false;
              const newToken = res.token;
              refreshTokenSubject.next(newToken);

              return next(req.clone({
                setHeaders: { Authorization: `Bearer ${newToken}` }
              }));
            }),
            catchError((err) => {
              isRefreshing = false;
              refreshTokenSubject.next(null);
              authService.logout();
              return throwError(() => err);
            })
          );
        } else {
          return refreshTokenSubject.pipe(
            filter(newToken => newToken !== null),
            take(1),
            switchMap((newToken) => {
              return next(req.clone({
                setHeaders: { Authorization: `Bearer ${newToken}` }
              }));
            })
          );
        }
      }
      return throwError(() => error);
    })
  );
};