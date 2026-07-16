import { __decorate } from "tslib";
// Angular import
import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
// project import
import { SpinnerComponent } from './theme/shared/components/spinner/spinner.component';
import { AuthService } from '../app/demo/Services/auth.service';
let AppComponent = class AppComponent {
    constructor() {
        this.title = 'SureShift';
        this.authService = inject(AuthService);
    }
    onLogout() {
        this.authService.logout();
    }
};
AppComponent = __decorate([
    Component({
        selector: 'app-root',
        templateUrl: './app.component.html',
        styleUrls: ['./app.component.scss'],
        imports: [RouterOutlet, SpinnerComponent]
    })
], AppComponent);
export { AppComponent };
//# sourceMappingURL=app.component.js.map