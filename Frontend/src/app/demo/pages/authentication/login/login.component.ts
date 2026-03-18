import { Component, inject, signal } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { email, Field, form, required } from '@angular/forms/signals';
import { AuthService } from 'src/app/demo/Services/auth.service';
import { FormsModule } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { HttpErrorResponse } from '@angular/common/http';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [RouterModule, Field, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  private authService = inject(AuthService);
  private router = inject(Router);
  private toastr = inject(ToastrService); 

  submitted = signal(false);
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

    // Extract values from the form signal
    const isEmailInvalid = this.loginForm.email().invalid();
    const isPasswordInvalid = this.loginForm.password().invalid();

    if (isEmailInvalid || isPasswordInvalid) {
      // 3. Show Warning Toast instead of inline error
      this.toastr.warning('Please check your email format and password.', 'Validation Error');
      return;
    }

    // Use setTimeout to move the state update out of the current change detection cycle
    setTimeout(() => {
      this.loading.set(true);

   this.authService.login(this.loginModal()).subscribe({
        next: () => {
          this.loading.set(false);
          this.toastr.success(`Successfully connected to ${this.loginModal().environment}!`, 'Login Success');
          this.router.navigate(['/dashboard']);
        },
        // ADD HttpErrorResponse right here 👇
        error: (err: HttpErrorResponse) => {
          this.loading.set(false);
          
          // Now TypeScript knows that 'err' has an 'error' property!
          const errorMessage = err.error?.message || 'Login failed. Check your credentials.';
          
          this.toastr.error(errorMessage, 'Authentication Failed');
          console.error('Login Error:', err);
        }
      });
    });
  }
}