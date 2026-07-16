import { __decorate } from "tslib";
import { Component, ViewEncapsulation, input, inject } from '@angular/core';
import { Router, NavigationStart, NavigationEnd, NavigationCancel, NavigationError } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { Spinkit } from './spinkits';
let SpinnerComponent = class SpinnerComponent {
    constructor() {
        this.router = inject(Router);
        // public props
        this.Spinkit = Spinkit;
        this.backgroundColor = input('#2689E2');
        this.spinner = input(Spinkit.skLine);
        // Convert router events to a reactive Signal
        this.isSpinnerVisible = toSignal(this.router.events.pipe(filter(event => event instanceof NavigationStart ||
            event instanceof NavigationEnd ||
            event instanceof NavigationCancel ||
            event instanceof NavigationError), map(event => event instanceof NavigationStart), // true if starting, false otherwise
        startWith(true) // Initial state
        ));
    }
};
SpinnerComponent = __decorate([
    Component({
        selector: 'app-spinner',
        templateUrl: './spinner.component.html',
        styleUrls: ['./spinner.component.scss', './spinkit-css/sk-line-material.scss'],
        encapsulation: ViewEncapsulation.None
    })
], SpinnerComponent);
export { SpinnerComponent };
//# sourceMappingURL=spinner.component.js.map