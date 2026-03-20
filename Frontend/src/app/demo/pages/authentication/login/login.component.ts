import { Component, inject, signal } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { email, Field, form, required } from '@angular/forms/signals';
import { AuthService } from 'src/app/demo/Services/auth.service';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-login',
  standalone: true, // Ensuring modern standalone structure
  imports: [RouterModule, Field, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  submitted = signal(false);
  error = signal('');
  loading = signal(false);

  // Model matching the backend expected body
  loginModal = signal({
    environment: 'production',
    email: '',
    password: ''
  });

  // Signal-based form validation
  loginForm = form(this.loginModal, (schemaPath) => {
    required(schemaPath.environment, { message: 'Environment is required' });
    required(schemaPath.email, { message: 'Email is required' });
    email(schemaPath.email, { message: 'Enter a valid email address' });
    required(schemaPath.password, { message: 'Password is required' });
  });

  onSubmit(event: Event) {
  event.preventDefault();
  this.submitted.set(true);
  this.error.set('');

  // Extract values from the form signal (assuming angular-signals-forms usage)
  const isEmailInvalid = this.loginForm.email().invalid();
  const isPasswordInvalid = this.loginForm.password().invalid();

  if (isEmailInvalid || isPasswordInvalid) {
    this.error.set('Please check your email format and password.');
    return;
  }

  // FIX: Use setTimeout to move the state update out of the current change detection cycle
  setTimeout(() => {
    this.loading.set(true);

    this.authService.login(this.loginModal()).subscribe({
      next: () => {
        this.loading.set(false);
        // Ensure redirect happens after state is set
        this.router.navigate(['/dashboard']);
      },
      error: (err) => {
        this.loading.set(false);
        const errorMessage = err.error?.message || 'Login failed. Check your credentials.';
        this.error.set(errorMessage);
        console.error('Login Error:', err);
      }
    });
  });
}
}