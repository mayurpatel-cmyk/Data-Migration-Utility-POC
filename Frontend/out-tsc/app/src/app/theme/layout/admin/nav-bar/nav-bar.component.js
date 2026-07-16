import { __decorate } from "tslib";
// Angular import
import { Component, output } from '@angular/core';
// project import
import { BerryConfig } from 'src/app/demo/Services/ConfigService';
import { NavLeftComponent } from './nav-left/nav-left.component';
import { NavLogoComponent } from './nav-logo/nav-logo.component';
import { NavRightComponent } from './nav-right/nav-right.component';
let NavBarComponent = class NavBarComponent {
    // Constructor
    constructor() {
        // public props
        this.NavCollapse = output();
        this.NavCollapsedMob = output();
        this.windowWidth = window.innerWidth;
        this.navCollapsed = this.windowWidth >= 1025 ? BerryConfig.isCollapse_menu : false;
        this.navCollapsedMob = false;
    }
    // public method
    navCollapse() {
        if (this.windowWidth >= 1025) {
            this.navCollapsed = !this.navCollapsed;
            this.NavCollapse.emit();
        }
    }
    navCollapseMob() {
        if (this.windowWidth < 1025) {
            this.NavCollapsedMob.emit();
        }
    }
};
NavBarComponent = __decorate([
    Component({
        selector: 'app-nav-bar',
        imports: [NavLogoComponent, NavLeftComponent, NavRightComponent],
        templateUrl: './nav-bar.component.html',
        styleUrls: ['./nav-bar.component.scss']
    })
], NavBarComponent);
export { NavBarComponent };
//# sourceMappingURL=nav-bar.component.js.map