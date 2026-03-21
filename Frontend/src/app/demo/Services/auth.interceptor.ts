// auth.interceptor.ts
import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from './auth.service'; // Adjust path if needed

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const user = authService.currentUser();

  // If we have a user with a token, clone the request and add headers
  if (user && user.accessToken && user.instanceUrl) {
    const clonedRequest = req.clone({
      setHeaders: {
        Authorization: `Bearer ${user.accessToken}`,
        'x-sf-url': user.instanceUrl 
      }
    });
    return next(clonedRequest);
  }

  // If no token, let the request pass through unmodified (e.g., login request)
  return next(req);
};