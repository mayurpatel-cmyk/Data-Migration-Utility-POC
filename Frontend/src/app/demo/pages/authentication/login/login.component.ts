import { Component, inject, signal } from '@angular/core';
import { RouterModule, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/demo/Services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  private authService = inject(AuthService);
  private toastr = inject(ToastrService);
  private router = inject(Router);

  loading = signal(false);
  error = signal('');
  isSignUpMode = signal(false); 
  isForgotPasswordMode = signal(false);

  fullName = signal(''); // NEW: Full Name state
  email = signal('');
  password = signal('');

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
  onSubmit(event: Event) {
    event.preventDefault();
    this.error.set('');

    // Handle Forgot Password Flow
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
      return; // Stop execution here for forgot password
     } else {
      const loginCredentials = { email: this.email(), password: this.password() };
      
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
  }
}