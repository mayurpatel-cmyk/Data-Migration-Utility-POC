import { __decorate } from "tslib";
// Angular Import
import { Component, Input, inject, ChangeDetectorRef } from '@angular/core'; // Added ChangeDetectorRef
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { Title } from '@angular/platform-browser';
// project import
import { NavigationItems } from 'src/app/theme/layout/admin/navigation/navigation';
import { SharedModule } from '../../shared.module';
let BreadcrumbComponent = class BreadcrumbComponent {
    // constructor
    constructor() {
        this.route = inject(Router);
        this.titleService = inject(Title);
        this.cdr = inject(ChangeDetectorRef); // <--- 1. Inject ChangeDetectorRef
        this.breadcrumbList = [];
        // <--- 2. THE FIX: Initialize this with an empty array instead of leaving it undefined
        this.navigationList = [];
        this.navigations = NavigationItems;
        this.type = 'icon';
        this.setBreadcrumb();
    }
    // public method
    setBreadcrumb() {
        this.route.events.subscribe((router) => {
            if (router instanceof NavigationEnd) {
                const activeLink = router.url;
                const breadcrumbList = this.filterNavigation(this.navigations, activeLink);
                const title = breadcrumbList[breadcrumbList.length - 1]?.title || 'Welcome';
                // 3. Update the list and safely trigger change detection
                this.navigationList = breadcrumbList.splice(-2);
                this.titleService.setTitle(title + ' | SureShift');
                this.cdr.detectChanges(); // Tell Angular the breadcrumb data has updated
            }
        });
    }
    filterNavigation(navItems, activeLink) {
        for (const navItem of navItems) {
            if (navItem.type === 'item' && 'url' in navItem && navItem.url === activeLink) {
                return [
                    {
                        url: 'url' in navItem ? navItem.url : false,
                        title: navItem.title,
                        breadcrumbs: 'breadcrumbs' in navItem ? navItem.breadcrumbs : true,
                        type: navItem.type
                    }
                ];
            }
            if ((navItem.type === 'group' || navItem.type === 'collapse') && 'children' in navItem) {
                const breadcrumbList = this.filterNavigation(navItem.children, activeLink);
                if (breadcrumbList.length > 0) {
                    breadcrumbList.unshift({
                        url: 'url' in navItem ? navItem.url : false,
                        title: navItem.title,
                        breadcrumbs: 'breadcrumbs' in navItem ? navItem.breadcrumbs : true,
                        type: navItem.type
                    });
                    return breadcrumbList;
                }
            }
        }
        return [];
    }
};
__decorate([
    Input()
], BreadcrumbComponent.prototype, "type", void 0);
BreadcrumbComponent = __decorate([
    Component({
        selector: 'app-breadcrumb',
        imports: [RouterModule, SharedModule],
        templateUrl: './breadcrumbs.component.html',
        styleUrls: ['./breadcrumbs.component.scss']
    })
], BreadcrumbComponent);
export { BreadcrumbComponent };
//# sourceMappingURL=breadcrumbs.component.js.map