import { __decorate } from "tslib";
// Angular import
import { Component, inject, input } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { SharedModule } from 'src/app/theme/shared/shared.module';
import { NavCollapseComponent } from '../nav-collapse/nav-collapse.component';
import { NavItemComponent } from '../nav-item/nav-item.component';
let NavGroupComponent = class NavGroupComponent {
    constructor() {
        this.location = inject(Location);
        // public props
        this.item = input.required();
    }
    // Life cycle events
    ngOnInit() {
        this.current_url = this.location.path();
        //eslint-disable-next-line
        //@ts-ignore
        const baseHref = this.location['_baseHref'] || '';
        this.current_url = baseHref + this.current_url;
        // Use a more reliable way to find and update the active group
        setTimeout(() => {
            const links = document.querySelectorAll('a.nav-link');
            links.forEach((link) => {
                if (link.getAttribute('href') === this.current_url) {
                    let parent = link.parentElement;
                    while (parent && parent.classList) {
                        if (parent.classList.contains('coded-hasmenu')) {
                            parent.classList.add('coded-trigger');
                            parent.classList.add('active');
                        }
                        parent = parent.parentElement;
                    }
                }
            });
        }, 0);
    }
};
NavGroupComponent = __decorate([
    Component({
        selector: 'app-nav-group',
        imports: [CommonModule, SharedModule, NavCollapseComponent, NavItemComponent],
        templateUrl: './nav-group.component.html',
        styleUrl: './nav-group.component.scss'
    })
], NavGroupComponent);
export { NavGroupComponent };
//# sourceMappingURL=nav-group.component.js.map