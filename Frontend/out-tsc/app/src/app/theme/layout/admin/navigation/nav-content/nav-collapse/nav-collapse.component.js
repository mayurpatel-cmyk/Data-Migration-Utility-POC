import { __decorate } from "tslib";
// Angular import
import { Component, inject, input } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SharedModule } from 'src/app/theme/shared/shared.module';
import { NavItemComponent } from '../nav-item/nav-item.component';
let NavCollapseComponent = class NavCollapseComponent {
    constructor() {
        this.location = inject(Location);
        // public props
        this.item = input.required();
        this.windowWidth = window.innerWidth;
        this.current_url = ''; // Add current URL property
    }
    ngOnInit() {
        this.current_url = this.location.path();
        // eslint-disable-next-line
        //@ts-ignore
        const baseHref = this.location['_baseHref'] || ''; // Use baseHref if necessary
        this.current_url = baseHref + this.current_url;
        // Timeout to allow DOM to fully render before checking for the links
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
    // Method to handle the collapse of the navigation menu
    navCollapse(e) {
        let parent = e.target;
        if (parent?.tagName === 'SPAN') {
            parent = parent.parentElement;
        }
        parent = parent.parentElement;
        const sections = document.querySelectorAll('.coded-hasmenu');
        for (let i = 0; i < sections.length; i++) {
            if (sections[i] !== parent) {
                sections[i].classList.remove('coded-trigger');
            }
        }
        let first_parent = parent.parentElement;
        let pre_parent = parent.parentElement.parentElement;
        if (first_parent.classList.contains('coded-hasmenu')) {
            do {
                first_parent.classList.add('coded-trigger');
                first_parent = first_parent.parentElement.parentElement;
            } while (first_parent.classList.contains('coded-hasmenu'));
        }
        else if (pre_parent.classList.contains('coded-submenu')) {
            do {
                pre_parent.parentElement?.classList.add('coded-trigger');
                pre_parent = pre_parent.parentElement.parentElement.parentElement;
            } while (pre_parent.classList.contains('coded-submenu'));
        }
        parent.classList.toggle('coded-trigger');
    }
};
NavCollapseComponent = __decorate([
    Component({
        selector: 'app-nav-collapse',
        imports: [CommonModule, SharedModule, RouterModule, NavItemComponent],
        templateUrl: './nav-collapse.component.html',
        styleUrl: './nav-collapse.component.scss'
    })
], NavCollapseComponent);
export { NavCollapseComponent };
//# sourceMappingURL=nav-collapse.component.js.map