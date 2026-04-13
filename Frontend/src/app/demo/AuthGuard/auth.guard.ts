import { inject } from '@angular/core';
import { Router, ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { AuthService } from '../Services/auth.service';

export const authGuard = (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // 1. Check if token is in storage
  const hasLocalToken = authService.isLoggedIn();

  // 2. Check if token is in the URL (Crucial for the first second of landing)
  const hasUrlToken = !!route.queryParams['token'];

  if (hasLocalToken || hasUrlToken) {
    return true; // Let them through!
  }

  // 3. Otherwise, go to login
  return router.parseUrl('/login');
};
