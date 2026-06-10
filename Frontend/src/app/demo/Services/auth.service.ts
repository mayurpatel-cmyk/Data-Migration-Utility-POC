import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { Router } from '@angular/router';

export interface AuthResponse {
  success: boolean;
  token?: string;
  refresh_token?: string;
  message?: string;
  user?: {
    id: string;
    email: string;
    full_name: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  
  private apiUrl = 'http://localhost:8000/api/auth';

  currentUser = signal<string | null>(localStorage.getItem('supabase_token'));

  login(credentials: any): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/login`, credentials).pipe(
      tap(res => {
        if (res.success && res.token && res.refresh_token) {
          // Store both tokens securely
          localStorage.setItem('supabase_token', res.token);
          localStorage.setItem('supabase_refresh', res.refresh_token);
          this.currentUser.set(res.token);
        }
      })
    );
  }

  signup(credentials: any): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/signup`, credentials);
  }

  // Use this method in your HTTP Interceptor when a 401 Unauthorized occurs
  refreshToken(): Observable<any> {
    const refreshToken = localStorage.getItem('supabase_refresh');
    return this.http.post<any>(`${this.apiUrl}/refresh`, { refresh_token: refreshToken }).pipe(
      tap(res => {
        if (res.success && res.token) {
          localStorage.setItem('supabase_token', res.token);
          localStorage.setItem('supabase_refresh', res.refresh_token);
          this.currentUser.set(res.token);
        }
      })
    );
  }

  isLoggedIn(): boolean {
    return !!this.currentUser();
  }

 forgotPassword(email: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/forgot-password`, { email });
  }

  private clearLocalSession() {
    localStorage.removeItem('supabase_token');
    localStorage.removeItem('supabase_refresh');
    this.currentUser.set(null);
    this.router.navigate(['/login']);
  }

  logout() {
    // 1. Tell the Python backend to kill the session
    this.http.post(`${this.apiUrl}/logout`, {}).subscribe({
      next: () => this.clearLocalSession(),
      error: () => this.clearLocalSession() // Clear it even if the server fails
    });
  }
}