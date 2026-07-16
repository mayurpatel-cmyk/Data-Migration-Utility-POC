import { __decorate } from "tslib";
// Angular import
import { Component, effect, inject } from '@angular/core';
import { CommonModule, Location, LocationStrategy } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ChangeDetectorRef } from '@angular/core';
// Project import
import { NavBarComponent } from './nav-bar/nav-bar.component';
import { NavigationComponent } from './navigation/navigation.component';
import { BreadcrumbComponent } from '../../shared/components/breadcrumbs/breadcrumbs.component';
import { LayoutStateService } from '../../shared/service/layout-state.service';
let AdminComponent = class AdminComponent {
    // Constructor
    constructor() {
        this.location = inject(Location);
        this.locationStrategy = inject(LocationStrategy);
        this.cdr = inject(ChangeDetectorRef);
        this.layoutState = inject(LayoutStateService);
        this.navCollapsed = false;
        this.navCollapsedMob = false;
        effect(() => {
            this.navCollapsedMob = this.layoutState.navCollapsedMob();
            this.cdr.detectChanges();
        });
    }
    // life cycle hook
    ngAfterViewInit() {
        this.windowWidth = window.innerWidth;
        this.cdr.detectChanges();
    }
    // private method
    isThemeLayout(layout) {
        this.currentLayout = layout;
    }
    // public method
    navMobClick() {
        this.layoutState.toggleNavCollapsedMob();
        if (document.querySelector('app-navigation.pc-sidebar')?.classList.contains('navbar-collapsed')) {
            document.querySelector('app-navigation.pc-sidebar')?.classList.remove('navbar-collapsed');
        }
    }
    handleKeyDown(event) {
        if (event.key === 'Escape') {
            this.closeMenu();
        }
    }
    closeMenu() {
        this.layoutState.toggleNavCollapsedMob();
    }
};
AdminComponent = __decorate([
    Component({
        selector: 'app-admin',
        imports: [CommonModule, NavigationComponent, NavBarComponent, RouterModule, BreadcrumbComponent],
        templateUrl: './admin.component.html',
        styleUrl: './admin.component.scss'
    })
], AdminComponent);
export { AdminComponent };
//# sourceMappingURL=admin.component.js.map