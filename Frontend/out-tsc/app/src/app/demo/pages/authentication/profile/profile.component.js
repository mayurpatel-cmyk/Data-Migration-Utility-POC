import { __decorate } from "tslib";
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
let ProfileComponent = class ProfileComponent {
    constructor(authService, toastr, router) {
        this.authService = authService;
        this.toastr = toastr;
        this.router = router;
        this.fullName = '';
        this.email = '';
        this.company = '';
        this.contact = '';
        this.otherInfo = '';
        this.loading = false;
        this.successMessage = '';
        this.errorMessage = '';
    }
    ngOnInit() {
        this.loadProfile();
    }
    loadProfile() {
        this.authService.getProfile().subscribe({
            next: (res) => {
                if (res.success && res.user) {
                    this.fullName = res.user.full_name || '';
                    this.email = res.user.email || '';
                    this.company = res.user.user_metadata?.company || '';
                    this.contact = res.user.user_metadata?.contact || '';
                    this.otherInfo = res.user.user_metadata?.other_info || '';
                }
            },
            error: (err) => {
                console.error('Unable to load profile', err);
                this.errorMessage = 'Unable to load profile data.';
            }
        });
    }
    saveProfile() {
        this.errorMessage = '';
        this.successMessage = '';
        this.loading = true;
        const payload = {
            full_name: this.fullName,
            email: this.email,
            company: this.company,
            contact: this.contact,
            other_info: this.otherInfo
        };
        this.authService.updateProfile(payload).subscribe({
            next: (res) => {
                this.loading = false;
                if (res.success) {
                    this.toastr.success('Profile updated successfully.', 'Success');
                    this.successMessage = 'Profile updated successfully.';
                    this.authService.setCurrentUserProfile({
                        full_name: this.fullName,
                        email: this.email,
                        company: this.company,
                        contact: this.contact,
                        other_info: this.otherInfo
                    });
                    this.router.navigate(['/data-import']);
                }
            },
            error: (err) => {
                this.loading = false;
                this.errorMessage = err.error?.detail || 'Unable to update profile.';
                this.toastr.error(this.errorMessage, 'Error');
            }
        });
    }
};
ProfileComponent = __decorate([
    Component({
        selector: 'app-profile',
        standalone: true,
        imports: [CommonModule, RouterModule, FormsModule],
        templateUrl: './profile.component.html',
        styleUrls: ['./profile.component.scss']
    })
], ProfileComponent);
export { ProfileComponent };
//# sourceMappingURL=profile.component.js.map