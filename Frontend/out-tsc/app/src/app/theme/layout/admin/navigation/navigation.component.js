import { __decorate } from "tslib";
// Angular import
import { Component, output } from '@angular/core';
import { RouterModule } from '@angular/router';
// project import
import { NavContentComponent } from './nav-content/nav-content.component';
let NavigationComponent = class NavigationComponent {
    constructor() {
        // public props
        this.NavCollapsedMob = output();
        this.SubmenuCollapse = output();
        this.navCollapsedMob = false;
        this.windowWidth = window.innerWidth;
    }
    // public method
    navCollapseMob() {
        if (this.windowWidth < 1025) {
            this.NavCollapsedMob.emit();
        }
    }
    navSubmenuCollapse() {
        document.querySelector('app-navigation.coded-navbar')?.classList.add('coded-trigger');
    }
};
NavigationComponent = __decorate([
    Component({
        selector: 'app-navigation',
        imports: [NavContentComponent, RouterModule],
        templateUrl: './navigation.component.html',
        styleUrl: './navigation.component.scss'
    })
], NavigationComponent);
export { NavigationComponent };
//# sourceMappingURL=navigation.component.js.map