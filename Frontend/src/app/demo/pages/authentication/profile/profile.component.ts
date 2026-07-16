import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from 'src/app/demo/Services/auth.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './profile.component.html',
  styleUrls: ['./profile.component.scss']
})
export class ProfileComponent implements OnInit {
  firstName = '';
  lastName = '';
  email = '';
  company = '';
  contact = '';
  otherInfo = '';
  loading = false;
  successMessage = '';
  errorMessage = '';

  constructor(
    private authService: AuthService,
    private toastr: ToastrService,
    public router: Router
  ) {}

  ngOnInit(): void {
    this.applyFallbackProfile();
    this.loadProfile();
  }

  loadProfile(): void {
    this.authService.getProfile().subscribe({
      next: (res: any) => {
        console.log('Profile response', res);
        if (res.success && res.user) {
          this.applyProfileData(res.user);
          this.errorMessage = '';
        } else {
          this.errorMessage = res.message || 'Unable to load profile data.';
          this.applyFallbackProfile();
        }
      },
      error: (err) => {
        console.error('Unable to load profile', err);
        this.errorMessage = err.error?.detail || 'Unable to load profile data.';
        this.applyFallbackProfile();
      }
    });
  }

  private applyProfileData(user: any): void {
    const fullName = user.full_name || '';
    const nameParts = fullName.trim().split(/\s+/);
    this.firstName = nameParts[0] || '';
    this.lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    this.email = user.email || '';
    this.company = user.user_metadata?.company || '';
    this.contact = user.user_metadata?.contact || '';
    this.otherInfo = user.user_metadata?.other_info || '';
  }

  private applyFallbackProfile(): void {
    const storedName = this.authService.currentUserName();
    const storedEmail = this.authService.currentUserEmail();
    const nameParts = storedName?.trim().split(/\s+/) || [];
    this.firstName = nameParts[0] || '';
    this.lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    this.email = storedEmail || this.email;
  }

  saveProfile(): void {
    this.errorMessage = '';
    this.successMessage = '';
    this.loading = true;

    const fullName = [this.firstName, this.lastName].filter(Boolean).join(' ').trim();
    const payload = {
      full_name: fullName,
      email: this.email,
      company: this.company,
      contact: this.contact,
      other_info: this.otherInfo
    };

    this.authService.updateProfile(payload).subscribe({
      next: (res: any) => {
        this.loading = false;
        if (res.success) {
          this.toastr.success('Profile updated successfully.', 'Success');
          this.successMessage = 'Profile updated successfully.';
          this.authService.setCurrentUserProfile({
            full_name: fullName,
            email: this.email,
            company: this.company,
            contact: this.contact,
            other_info: this.otherInfo
          });
          this.router.navigate(['/data-import']);
        } else {
          this.errorMessage = res.message || 'Unable to update profile.';
          this.toastr.error(this.errorMessage, 'Error');
        }
      },
      error: (err) => {
        this.loading = false;
        this.errorMessage = err.error?.detail || 'Unable to update profile.';
        this.toastr.error(this.errorMessage, 'Error');
      }
    });
  }
}
