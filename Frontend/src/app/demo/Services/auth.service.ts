import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { Router } from '@angular/router';

export interface LoginCredentials {
  environment: string;
  email: string;
  password?: string;
  //securityToken?: string; // 1. Added Security Token for Salesforce
}

export interface AuthResponse {
  success: boolean;
  message: string;
  token: string;          // 2. Added the JWT token returned by Node
  user: {                 // 3. Updated to match the real backend user object
    id: string;
    email: string;
    environment: string;
    sfUrl: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private apiUrl = 'http://localhost:3000/api/auth/login';

  // Initialize signal from localStorage to persist login on refresh
  currentUser = signal<AuthResponse['user'] | null>(
    JSON.parse(localStorage.getItem('user_data') || 'null')
  );

  login(credentials: LoginCredentials): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(this.apiUrl, credentials).pipe(
      tap((response) => {
        if (response.success && response.user && response.token) {
          // 1. Persist data
          localStorage.setItem('user_data', JSON.stringify(response.user));
          localStorage.setItem('token', response.token);

          // 2. Update Signal (This allows AuthGuard to pass)
          this.currentUser.set(response.user);
        }
      })
    );
  }

  logout() {
    localStorage.removeItem('user_data');
    this.currentUser.set(null);
    this.router.navigate(['/login']);
  }

  isLoggedIn(): boolean {
    return !!this.currentUser();
  }
}
