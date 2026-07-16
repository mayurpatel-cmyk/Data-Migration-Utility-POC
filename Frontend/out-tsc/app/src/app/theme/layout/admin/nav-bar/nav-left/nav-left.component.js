import { __decorate } from "tslib";
// Angular import
import { Component, output } from '@angular/core';
let NavLeftComponent = class NavLeftComponent {
    constructor() {
        // public props
        this.NavCollapsedMob = output();
    }
    navCollapsedMob() {
        this.NavCollapsedMob.emit();
    }
};
NavLeftComponent = __decorate([
    Component({
        selector: 'app-nav-left',
        templateUrl: './nav-left.component.html',
        styleUrls: ['./nav-left.component.scss']
    })
], NavLeftComponent);
export { NavLeftComponent };
//# sourceMappingURL=nav-left.component.js.map