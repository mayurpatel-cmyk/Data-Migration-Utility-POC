import { inject } from '@angular/core';
import { Router, ActivatedRouteSnapshot } from '@angular/router';
import { AuthService } from '../Services/auth.service';

export const authGuard = (route: ActivatedRouteSnapshot) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // 1. If already logged in, let them through
  if (authService.isLoggedIn()) {
    return true;
  }

  // 2. Check if we are currently arriving from the Salesforce redirect
  const token = route.queryParamMap.get('token');
  const instanceUrl = route.queryParamMap.get('instanceUrl');

  if (token && instanceUrl) {
    // Save the credentials into storage/signals immediately
    authService.handleOAuthLogin(token, instanceUrl);
    return true;
  }

  // 3. Otherwise, redirect to login
  return router.parseUrl('/login');
};