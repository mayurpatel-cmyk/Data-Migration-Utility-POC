import { __decorate } from "tslib";
// angular import
import { CommonModule } from '@angular/common';
import { Component, ViewChild } from '@angular/core';
// third party
import { NgApexchartsModule } from 'ng-apexcharts';
let ChartDataMonthComponent = class ChartDataMonthComponent {
    constructor() {
        this.amount = 961;
    }
    // life cycle event
    ngOnInit() {
        this.btnActive = 'year';
        this.chartOptions = {
            chart: {
                type: 'line',
                height: 90,
                sparkline: {
                    enabled: true
                }
            },
            dataLabels: {
                enabled: false
            },
            colors: ['#FFF'],
            stroke: {
                curve: 'smooth',
                width: 3
            },
            series: [
                {
                    name: 'series1',
                    data: [35, 44, 9, 54, 45, 66, 41, 69]
                }
            ],
            yaxis: {
                min: 5,
                max: 95
            },
            tooltip: {
                theme: 'dark',
                fixed: {
                    enabled: false
                },
                x: {
                    show: false
                },
                marker: {
                    show: false
                }
            }
        };
    }
    handleKeyDown(event, value) {
        if (event.key === 'Enter' || event.key === ' ') {
            this.toggleActive(value);
            event.preventDefault(); // Prevent default scrolling for the spacebar key
        }
    }
    // public method
    toggleActive(value) {
        this.btnActive = value;
        this.chartOptions.series = [
            {
                name: 'series1',
                data: value === 'month' ? [45, 66, 41, 89, 25, 44, 9, 54] : [35, 44, 9, 54, 45, 66, 41, 69]
            }
        ];
        this.amount = value === 'month' ? 108 : 961;
    }
};
__decorate([
    ViewChild('chart')
], ChartDataMonthComponent.prototype, "chart", void 0);
ChartDataMonthComponent = __decorate([
    Component({
        selector: 'app-chart-data-month',
        imports: [CommonModule, NgApexchartsModule],
        templateUrl: './chart-data-month.component.html',
        styleUrl: './chart-data-month.component.scss'
    })
], ChartDataMonthComponent);
export { ChartDataMonthComponent };
//# sourceMappingURL=chart-data-month.component.js.map