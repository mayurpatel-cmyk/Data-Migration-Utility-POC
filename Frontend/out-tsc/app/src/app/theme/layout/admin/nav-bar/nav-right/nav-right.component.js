import { __decorate } from "tslib";
import { Component } from '@angular/core';
import { RouterModule, NavigationEnd } from '@angular/router';
import { CommonModule } from '@angular/common';
import { filter } from 'rxjs/operators';
import { SharedModule } from 'src/app/theme/shared/shared.module';
let NavRightComponent = class NavRightComponent {
    constructor(cdr, router, authService) {
        this.cdr = cdr;
        this.router = router;
        this.authService = authService;
        this.currentUserName = null;
        this.currentUserEmail = null;
    }
    ngOnInit() {
        this.loadCurrentUser();
        this.routerSub = this.router.events.pipe(filter(event => event instanceof NavigationEnd)).subscribe(() => {
            this.loadCurrentUser();
        });
    }
    ngOnDestroy() {
        if (this.routerSub) {
            this.routerSub.unsubscribe();
        }
    }
    loadCurrentUser() {
        this.currentUserName = this.authService.currentUserName();
        this.currentUserEmail = this.authService.currentUserEmail();
        this.cdr.detectChanges();
    }
    getDisplayName(fullName) {
        if (!fullName) {
            return 'Guest';
        }
        const parts = fullName.trim().split(/\s+/);
        if (parts.length === 0) {
            return 'Guest';
        }
        if (parts.length === 1) {
            return parts[0];
        }
        return `${parts[0]} ${parts[parts.length - 1]}`;
    }
    onLogout() {
        this.authService.logout();
    }
};
NavRightComponent = __decorate([
    Component({
        selector: 'app-nav-right',
        standalone: true,
        imports: [RouterModule, SharedModule, CommonModule],
        templateUrl: './nav-right.component.html',
        styleUrls: ['./nav-right.component.scss']
    })
], NavRightComponent);
export { NavRightComponent };
//# sourceMappingURL=nav-right.component.js.map