import { __decorate } from "tslib";
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs';
import { Router } from '@angular/router';
let AuthService = class AuthService {
    constructor() {
        this.http = inject(HttpClient);
        this.router = inject(Router);
        this.apiUrl = 'http://localhost:8000/api/auth';
        this.currentUser = signal(localStorage.getItem('supabase_token'));
        this.currentUserName = signal(localStorage.getItem('current_user_name'));
        this.currentUserEmail = signal(localStorage.getItem('current_user_email'));
    }
    login(credentials) {
        return this.http.post(`${this.apiUrl}/login`, credentials).pipe(tap(res => {
            if (res.success && res.token && res.refresh_token) {
                const userName = res.user?.full_name || res.user?.email || '';
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
        }));
    }
    setCurrentUserProfile(profile) {
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
    getProfile() {
        return this.http.get(`${this.apiUrl}/profile`);
    }
    updateProfile(payload) {
        return this.http.put(`${this.apiUrl}/profile`, payload).pipe(tap((res) => {
            if (res.success && res.user) {
                this.setCurrentUserProfile({
                    full_name: res.user.full_name,
                    email: res.user.email,
                    company: res.user.user_metadata?.company,
                    contact: res.user.user_metadata?.contact,
                    other_info: res.user.user_metadata?.other_info
                });
            }
        }));
    }
    signup(data) {
        return this.http.post(`${this.apiUrl}/signup`, data);
    }
    // Use this method in your HTTP Interceptor when a 401 Unauthorized occurs
    refreshToken() {
        const refreshToken = localStorage.getItem('supabase_refresh');
        return this.http.post(`${this.apiUrl}/refresh`, { refresh_token: refreshToken }).pipe(tap(res => {
            if (res.success && res.token) {
                localStorage.setItem('supabase_token', res.token);
                localStorage.setItem('supabase_refresh', res.refresh_token);
                this.currentUser.set(res.token);
            }
        }));
    }
    isLoggedIn() {
        return !!this.currentUser();
    }
    forgotPassword(email) {
        return this.http.post(`${this.apiUrl}/forgot-password`, { email });
    }
    clearLocalSession() {
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
};
AuthService = __decorate([
    Injectable({
        providedIn: 'root'
    })
], AuthService);
export { AuthService };
//# sourceMappingURL=auth.service.js.map