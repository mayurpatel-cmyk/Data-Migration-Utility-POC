import { __decorate } from "tslib";
// Angular import
import { CommonModule } from '@angular/common';
import { Component, inject, Renderer2 } from '@angular/core';
// project import
import { BerryConfig } from 'src/app/demo/Services/ConfigService';
let ConfigurationComponent = class ConfigurationComponent {
    constructor() {
        this.renderer = inject(Renderer2);
    }
    // life cycle event
    ngOnInit() {
        this.setFontFamily = BerryConfig.font_family;
        this.fontFamily(this.setFontFamily);
    }
    // public method
    fontFamily(font) {
        this.setFontFamily = font;
        this.renderer.removeClass(document.body, 'Roboto');
        this.renderer.removeClass(document.body, 'Poppins');
        this.renderer.removeClass(document.body, 'Inter');
        this.renderer.addClass(document.body, font);
    }
};
ConfigurationComponent = __decorate([
    Component({
        selector: 'app-configuration',
        imports: [CommonModule],
        templateUrl: './configuration.component.html',
        styleUrls: ['./configuration.component.scss']
    })
], ConfigurationComponent);
export { ConfigurationComponent };
//# sourceMappingURL=configuration.component.js.map