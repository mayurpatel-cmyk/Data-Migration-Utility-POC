import { __decorate } from "tslib";
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
let MigrationDocsComponent = class MigrationDocsComponent {
    constructor() {
        this.activeTab = 'overview';
        this.isPrinting = false;
    }
    setActiveTab(tabName) {
        this.activeTab = tabName;
    }
    downloadPDF() {
        this.isPrinting = true;
        setTimeout(() => {
            window.print();
            this.isPrinting = false;
        }, 150);
    }
};
MigrationDocsComponent = __decorate([
    Component({
        selector: 'app-migration-docs',
        standalone: true,
        imports: [CommonModule, CardComponent],
        templateUrl: './migration-docs.component.html',
        styleUrls: []
    })
], MigrationDocsComponent);
export { MigrationDocsComponent };
//# sourceMappingURL=migration-docs.component.js.map