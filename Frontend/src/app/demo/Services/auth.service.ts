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
    user_metadata?: Record<string, string>;
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
  currentUserName = signal<string | null>(localStorage.getItem('current_user_name'));
  currentUserEmail = signal<string | null>(localStorage.getItem('current_user_email'));

  login(credentials: any): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/login`, credentials).pipe(
      tap(res => {
        if (res.success && res.token && res.refresh_token) {
          const userName = res.user?.['full_name'] || res.user?.user_metadata?.['full_name'] || res.user?.email || '';
          const userEmail = res.user?.email || '';

          // Store both tokens and profile metadata
          localStorage.setItem('supabase_token', res.token);
          localStorage.setItem('supabase_refresh', res.refresh_token);
          localStorage.setItem('current_user_name', userName);
          localStorage.setItem('current_user_email', userEmail);

          this.currentUser.set(res.token);
          this.currentUserName.set(userName || null);
          this.currentUserEmail.set(userEmail || null);
        }
      })
    );
  }

  setCurrentUserProfile(profile: { full_name?: string; email?: string; company?: string; contact?: string; other_info?: string }): void {
    const userName = profile.full_name || this.currentUserName();
    const userEmail = profile.email || this.currentUserEmail();

    if (userName !== null) {
      localStorage.setItem('current_user_name', userName);
      this.currentUserName.set(userName);
    }
    if (userEmail !== null) {
      localStorage.setItem('current_user_email', userEmail);
      this.currentUserEmail.set(userEmail);
    }
  }

  getProfile(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/profile`);
  }

  updateProfile(payload: { full_name?: string; email?: string; company?: string; contact?: string; other_info?: string }): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/profile`, payload).pipe(
      tap((res: any) => {
        if (res.success && res.user) {
          this.setCurrentUserProfile({
            full_name: res.user.full_name,
            email: res.user.email,
            company: res.user.user_metadata?.company,
            contact: res.user.user_metadata?.contact,
            other_info: res.user.user_metadata?.other_info
          });
        }
      })
    );
  }

  signup(data: { email: string; password: string; full_name: string }) {
  return this.http.post<any>(`${this.apiUrl}/signup`, data);
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
    localStorage.removeItem('current_user_name');
    localStorage.removeItem('current_user_email');
    this.currentUser.set(null);
    this.currentUserName.set(null);
    this.currentUserEmail.set(null);
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