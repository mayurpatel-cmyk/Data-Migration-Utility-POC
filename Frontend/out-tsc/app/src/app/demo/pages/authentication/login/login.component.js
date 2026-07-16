import { __decorate } from "tslib";
import { Component, inject, signal } from '@angular/core';
import { RouterModule, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/demo/Services/auth.service';
let LoginComponent = class LoginComponent {
    constructor() {
        this.authService = inject(AuthService);
        this.toastr = inject(ToastrService);
        this.router = inject(Router);
        this.loading = signal(false);
        this.error = signal('');
        this.isSignUpMode = signal(false);
        this.isForgotPasswordMode = signal(false);
        this.fullName = signal(''); // NEW: Full Name state
        this.email = signal('');
        this.password = signal('');
    }
    toggleMode() {
        this.isSignUpMode.set(!this.isSignUpMode());
        this.isForgotPasswordMode.set(false);
        this.error.set('');
        this.fullName.set('');
    }
    // Add a method to toggle the forgot password view specifically
    toggleForgotPassword() {
        this.isForgotPasswordMode.set(!this.isForgotPasswordMode());
        this.isSignUpMode.set(false);
        this.error.set('');
    }
    // Update onSubmit to handle the Forgot Password flow
    onSubmit(event) {
        event.preventDefault();
        this.error.set('');
        // 1. Handle Forgot Password Flow
        if (this.isForgotPasswordMode()) {
            if (!this.email()) {
                this.error.set('Please enter your email address.');
                return;
            }
            this.loading.set(true);
            this.authService.forgotPassword(this.email()).subscribe({
                next: (res) => {
                    this.toastr.success(res.message, 'Email Sent');
                    this.toggleForgotPassword(); // Go back to login
                    this.loading.set(false);
                },
                error: () => {
                    // Security best practice: don't reveal if the email actually exists
                    this.toastr.success('If that email exists, a reset link has been sent.', 'Email Sent');
                    this.toggleForgotPassword();
                    this.loading.set(false);
                }
            });
            return; // Stop execution here
        }
        // 2. Handle Sign-Up Flow
        if (this.isSignUpMode()) {
            // Note the keys here should match what your FastAPI backend expects (full_name)
            const signUpData = {
                email: this.email(),
                password: this.password(),
                full_name: this.fullName()
            };
            this.loading.set(true);
            // Assuming your Angular authService has a 'signup' method
            this.authService.signup(signUpData).subscribe({
                next: () => {
                    this.toastr.success('Account created successfully! Please log in.', 'Success');
                    this.loading.set(false);
                    this.toggleMode(); // Switch them back to the login view
                },
                error: (err) => {
                    // Handle backend FastAPI error format
                    this.error.set(err.error?.detail || 'Sign up failed. Please try again.');
                    this.loading.set(false);
                }
            });
            return; // Stop execution here
        }
        // 3. Handle Login Flow (Default)
        const loginCredentials = { email: this.email(), password: this.password() };
        this.loading.set(true);
        this.authService.login(loginCredentials).subscribe({
            next: () => {
                this.toastr.success('Welcome back!', 'Success');
                this.loading.set(false);
                this.router.navigate(['/connection']);
            },
            error: (err) => {
                this.error.set(err.error?.detail || 'Invalid credentials.');
                this.loading.set(false);
            }
        });
    }
};
LoginComponent = __decorate([
    Component({
        selector: 'app-login',
        standalone: true,
        imports: [CommonModule, RouterModule, FormsModule],
        templateUrl: './login.component.html',
        styleUrls: ['./login.component.scss']
    })
], LoginComponent);
export { LoginComponent };
//# sourceMappingURL=login.component.js.map