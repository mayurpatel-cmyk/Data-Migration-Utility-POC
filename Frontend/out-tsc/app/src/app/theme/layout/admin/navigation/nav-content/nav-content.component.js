import { __decorate } from "tslib";
// Angular import
import { Component, output, inject } from '@angular/core';
import { Location } from '@angular/common';
import { RouterModule } from '@angular/router';
//theme version
import { environment } from 'src/environments/environment';
// project import
import { NavigationItems } from '../navigation';
import { NavCollapseComponent } from './nav-collapse/nav-collapse.component';
import { NavGroupComponent } from './nav-group/nav-group.component';
import { NavItemComponent } from './nav-item/nav-item.component';
// NgScrollbarModule
import { SharedModule } from 'src/app/theme/shared/shared.module';
let NavContentComponent = class NavContentComponent {
    // Constructor
    constructor() {
        this.location = inject(Location);
        // public props
        this.NavCollapsedMob = output();
        this.SubmenuCollapse = output();
        // version
        this.title = 'Demo application for version numbering';
        this.currentApplicationVersion = environment.appVersion;
        this.navigations = NavigationItems;
        this.windowWidth = window.innerWidth;
    }
    // Life cycle events
    ngOnInit() {
        if (this.windowWidth < 1025) {
            setTimeout(() => {
                document.querySelector('.coded-navbar').classList.add('menupos-static');
            }, 500);
        }
    }
    fireOutClick() {
        let current_url = this.location.path();
        // eslint-disable-next-line
        // @ts-ignore
        if (this.location['_baseHref']) {
            // eslint-disable-next-line
            // @ts-ignore
            current_url = this.location['_baseHref'] + this.location.path();
        }
        const link = "a.nav-link[ href='" + current_url + "' ]";
        const ele = document.querySelector(link);
        if (ele !== null && ele !== undefined) {
            const parent = ele.parentElement;
            const up_parent = parent?.parentElement?.parentElement;
            const last_parent = up_parent?.parentElement;
            if (parent?.classList.contains('coded-hasmenu')) {
                parent.classList.add('coded-trigger');
                parent.classList.add('active');
            }
            else if (up_parent?.classList.contains('coded-hasmenu')) {
                up_parent.classList.add('coded-trigger');
                up_parent.classList.add('active');
            }
            else if (last_parent?.classList.contains('coded-hasmenu')) {
                last_parent.classList.add('coded-trigger');
                last_parent.classList.add('active');
            }
        }
    }
};
NavContentComponent = __decorate([
    Component({
        selector: 'app-nav-content',
        imports: [RouterModule, NavCollapseComponent, NavGroupComponent, NavItemComponent, SharedModule],
        templateUrl: './nav-content.component.html',
        styleUrl: './nav-content.component.scss'
    })
], NavContentComponent);
export { NavContentComponent };
//# sourceMappingURL=nav-content.component.js.map