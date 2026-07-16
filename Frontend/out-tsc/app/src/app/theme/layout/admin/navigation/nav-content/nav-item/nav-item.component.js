import { __decorate } from "tslib";
// Angular import
import { Component, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SharedModule } from 'src/app/theme/shared/shared.module';
import { LayoutStateService } from 'src/app/theme/shared/service/layout-state.service';
let NavItemComponent = class NavItemComponent {
    constructor() {
        // public props
        this.item = input.required();
        this.layoutState = inject(LayoutStateService);
    }
    // public method
    closeOtherMenu(event) {
        const ele = event.target;
        if (ele !== null && ele !== undefined) {
            const parent = ele.parentElement;
            const up_parent = parent.parentElement.parentElement.parentElement;
            const last_parent = up_parent.parentElement.parentElement;
            if (last_parent.classList.contains('coded-submenu')) {
                up_parent.classList.remove('coded-trigger');
                up_parent.classList.remove('active');
            }
            else {
                const sections = document.querySelectorAll('.coded-hasmenu');
                for (let i = 0; i < sections.length; i++) {
                    sections[i].classList.remove('active');
                    sections[i].classList.remove('coded-trigger');
                }
            }
            if (parent.classList.contains('coded-hasmenu')) {
                parent.classList.add('coded-trigger');
                parent.classList.add('active');
            }
            else if (up_parent.classList.contains('coded-hasmenu')) {
                up_parent.classList.add('coded-trigger');
                up_parent.classList.add('active');
            }
            else if (last_parent.classList.contains('coded-hasmenu')) {
                last_parent.classList.add('coded-trigger');
                last_parent.classList.add('active');
            }
        }
        // this.layoutState.toggleNavCollapsedMob();
        if (document.querySelector('app-navigation.coded-navbar').classList.contains('mob-open')) {
            document.querySelector('app-navigation.coded-navbar').classList.remove('mob-open');
        }
    }
};
NavItemComponent = __decorate([
    Component({
        selector: 'app-nav-item',
        imports: [CommonModule, SharedModule, RouterModule],
        templateUrl: './nav-item.component.html',
        styleUrl: './nav-item.component.scss'
    })
], NavItemComponent);
export { NavItemComponent };
//# sourceMappingURL=nav-item.component.js.map