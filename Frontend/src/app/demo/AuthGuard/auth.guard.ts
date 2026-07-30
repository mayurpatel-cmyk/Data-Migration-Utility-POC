import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../Services/auth.service'; // Verify this path

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Simply check if the Supabase token exists in our service
  if (authService.isLoggedIn()) {
    return true;
  }

  // If not logged in, boot them back to the login page
  router.navigate(['/login']);
  return false;
};