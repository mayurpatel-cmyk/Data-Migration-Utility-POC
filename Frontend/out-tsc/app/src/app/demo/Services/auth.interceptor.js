import { inject } from '@angular/core';
import { throwError, BehaviorSubject } from 'rxjs';
import { catchError, switchMap, filter, take } from 'rxjs/operators';
import { AuthService } from './auth.service';
let isRefreshing = false;
let refreshTokenSubject = new BehaviorSubject(null);
export const authInterceptor = (req, next) => {
    const authService = inject(AuthService);
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
    // 3. ATTACH TOKEN (With Debug Log!)
    let authReq = req;
    if (token) {
        console.log(`[Interceptor] Attaching token to: ${req.url}`); // <-- DEBUG LOG
        authReq = req.clone({
            setHeaders: { Authorization: `Bearer ${token}` }
        });
    }
    else {
        console.warn(`[Interceptor] NO TOKEN FOUND for: ${req.url}`); // <-- DEBUG LOG
    }
    // 4. HANDLE RESPONSES
    return next(authReq).pipe(catchError((error) => {
        if (error.status === 401 && token) {
            if (!isRefreshing) {
                isRefreshing = true;
                refreshTokenSubject.next(null);
                return authService.refreshToken().pipe(switchMap((res) => {
                    isRefreshing = false;
                    const newToken = res.token;
                    refreshTokenSubject.next(newToken);
                    return next(req.clone({
                        setHeaders: { Authorization: `Bearer ${newToken}` }
                    }));
                }), catchError((err) => {
                    isRefreshing = false;
                    authService.logout();
                    return throwError(() => err);
                }));
            }
            else {
                return refreshTokenSubject.pipe(filter(newToken => newToken !== null), take(1), switchMap((newToken) => {
                    return next(req.clone({
                        setHeaders: { Authorization: `Bearer ${newToken}` }
                    }));
                }));
            }
        }
        return throwError(() => error);
    }));
};
//# sourceMappingURL=auth.interceptor.js.map