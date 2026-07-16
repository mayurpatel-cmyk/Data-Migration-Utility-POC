import { __decorate } from "tslib";
// Angular Imports
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
// project import
import { CardComponent } from './components/card/card.component';
// third party
import { NgScrollbarModule } from 'ngx-scrollbar';
// bootstrap import
import { NgbDropdownModule, NgbNavModule, NgbModule, NgbCollapseModule } from '@ng-bootstrap/ng-bootstrap';
let SharedModule = class SharedModule {
};
SharedModule = __decorate([
    NgModule({
        imports: [
            CommonModule,
            FormsModule,
            ReactiveFormsModule,
            CardComponent,
            NgbDropdownModule,
            NgbNavModule,
            NgbModule,
            NgbCollapseModule,
            NgScrollbarModule
        ],
        exports: [
            CommonModule,
            FormsModule,
            ReactiveFormsModule,
            CardComponent,
            NgbModule,
            NgbDropdownModule,
            NgbNavModule,
            NgbCollapseModule,
            NgScrollbarModule
        ],
        declarations: []
    })
], SharedModule);
export { SharedModule };
//# sourceMappingURL=shared.module.js.map