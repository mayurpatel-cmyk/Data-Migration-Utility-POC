import { __decorate } from "tslib";
import { Component, input } from '@angular/core';
let CardComponent = class CardComponent {
    constructor() {
        // Initialize as Signal inputs
        this.cardTitle = input('');
        this.customHeader = input(false);
    }
};
CardComponent = __decorate([
    Component({
        selector: 'app-card',
        standalone: true, // (Assuming standalone based on 'imports: []')
        templateUrl: './card.component.html',
        styleUrl: './card.component.scss'
    })
], CardComponent);
export { CardComponent };
//# sourceMappingURL=card.component.js.map