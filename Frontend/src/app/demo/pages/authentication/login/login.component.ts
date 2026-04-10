import { Component, inject, signal } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';

// These come from your specific form signals library
import { Field, form, required } from '@angular/forms/signals';

// Make sure this path matches where your AuthService is located!
import { AuthService } from 'src/app/demo/Services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, RouterModule, Field, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  private authService = inject(AuthService);
  private toastr = inject(ToastrService);

  // Signals for form state
  loading = signal(false);
  error = signal('');
  submitted = signal(false);
  selectedEnvironment = signal('production');

  loginModal = signal({
    environment: 'production'
  });

  loginForm = form(this.loginModal, (schemaPath) => {
    required(schemaPath.environment, { message: 'Environment is required' });
  });

  onSubmit(event: Event) {
    event.preventDefault();
    this.submitted.set(true);
    this.error.set('');
    this.loading.set(true);

    // Get the selected environment from the signal
    const environment = this.selectedEnvironment();
    console.log("Selected Environment:", environment);

    // Validate environment value
    if (!environment || (environment !== 'production' && environment !== 'sandbox')) {
      this.loading.set(false);
      const errorMessage = 'Invalid environment selected';
      this.error.set(errorMessage);
      this.toastr.error(errorMessage, 'Validation Error');
      return;
    }

    // Call backend with the correctly selected environment
    this.authService.getSalesforceAuthUrl(environment).subscribe({
      next: (res: any) => {
        console.log('Received OAuth URL:', res.url);
        window.location.href = res.url;
      },
      error: (err) => {
        this.loading.set(false);
        const errorMessage = err.error?.message || 'Failed to connect to Salesforce.';
        this.error.set(errorMessage);
        this.toastr.error(errorMessage, 'Connection Error');
        console.error('Auth URL Error:', err);
      }
    });
  }
}
