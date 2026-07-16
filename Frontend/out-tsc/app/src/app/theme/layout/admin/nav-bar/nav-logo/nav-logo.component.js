import { __decorate } from "tslib";
// Angular import
import { Component, Input, output, inject } from '@angular/core';
import { Router } from '@angular/router';
// project import
import { SharedModule } from 'src/app/theme/shared/shared.module';
let NavLogoComponent = class NavLogoComponent {
    // Constructor
    constructor() {
        this.router = inject(Router);
        this.NavCollapse = output();
        this.windowWidth = window.innerWidth;
    }
    // public method
    navCollapse() {
        if (this.windowWidth >= 1025) {
            this.navCollapsed = !this.navCollapsed;
            this.NavCollapse.emit();
        }
    }
    returnToHome() {
        this.router.navigate(['/default']);
    }
};
__decorate([
    Input()
], NavLogoComponent.prototype, "navCollapsed", void 0);
NavLogoComponent = __decorate([
    Component({
        selector: 'app-nav-logo',
        imports: [SharedModule],
        templateUrl: './nav-logo.component.html',
        styleUrl: './nav-logo.component.scss'
    })
], NavLogoComponent);
export { NavLogoComponent };
//# sourceMappingURL=nav-logo.component.js.map