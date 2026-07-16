import { __decorate } from "tslib";
import { Injectable, signal } from '@angular/core';
/**
 * Central layout state for coordinating mobile sidebar open/close.
 */
let LayoutStateService = class LayoutStateService {
    constructor() {
        // true when the mobile sidebar should be open
        this.navCollapsedMob = signal(false);
    }
    toggleNavCollapsedMob() {
        this.navCollapsedMob.update((isOpen) => !isOpen);
    }
    openNavCollapsedMob() {
        this.navCollapsedMob.set(true);
    }
    closeNavCollapsedMob() {
        this.navCollapsedMob.set(false);
    }
};
LayoutStateService = __decorate([
    Injectable({ providedIn: 'root' })
], LayoutStateService);
export { LayoutStateService };
//# sourceMappingURL=layout-state.service.js.map