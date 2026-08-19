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

  router.navigate(['/login'], { replaceUrl: true });
  return false;
};