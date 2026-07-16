import { __decorate } from "tslib";
// angular import
import { Component, ViewChild } from '@angular/core';
// third party
import { NgApexchartsModule } from 'ng-apexcharts';
let BajajChartComponent = class BajajChartComponent {
    // constructor
    constructor() {
        this.chartOptions = {
            chart: {
                type: 'area',
                height: 95,
                stacked: true,
                sparkline: {
                    enabled: true
                },
                background: 'transparent'
            },
            stroke: {
                curve: 'smooth',
                width: 1
            },
            series: [
                {
                    data: [0, 15, 10, 50, 30, 40, 25]
                }
            ],
            tooltip: {
                theme: 'light',
                fixed: {
                    enabled: false
                },
                x: {
                    show: false
                },
                y: {
                    title: {
                        formatter: () => 'Ticket '
                    }
                },
                marker: {
                    show: false
                }
            },
            colors: ['#673ab7']
        };
    }
};
__decorate([
    ViewChild('chart')
], BajajChartComponent.prototype, "chart", void 0);
BajajChartComponent = __decorate([
    Component({
        selector: 'app-bajaj-chart',
        imports: [NgApexchartsModule],
        templateUrl: './bajaj-chart.component.html',
        styleUrl: './bajaj-chart.component.scss'
    })
], BajajChartComponent);
export { BajajChartComponent };
//# sourceMappingURL=bajaj-chart.component.js.map