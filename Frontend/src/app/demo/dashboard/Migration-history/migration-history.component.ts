import { Component, OnInit, OnDestroy, ViewChild, ElementRef, inject, Injector, NgZone, afterNextRender, signal, computed } from '@angular/core';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import {
  MigrationApiService,
  MigrationHistoryRecord,
  ValidationHistoryRecord,
  AnalyticsSummary,
  HistoryFilters,
} from '../../../services/migration-history.service';

Chart.register(...registerables);

type HistoryTab = 'migrations' | 'validations';

interface KpiCard {
  icon: string;
  label: string;
  value: string;
  sublabel: string;
  accent: 'primary' | 'success' | 'danger' | 'info' | 'warning';
}

@Component({
  selector: 'app-migration-history',
  standalone: true,
  imports: [CommonModule, FormsModule],
  providers: [DatePipe, TitleCasePipe],
  templateUrl: './migration-history.component.html',
  styleUrls: ['./migration-history.component.scss']
})
export class MigrationHistoryComponent implements OnInit, OnDestroy {
  private migrationApi = inject(MigrationApiService);
  private titleCasePipe = inject(TitleCasePipe);
  private injector = inject(Injector);
  private zone = inject(NgZone);

  @ViewChild('trendCanvas') trendCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('objectCanvas') objectCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('pathwayCanvas') pathwayCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('errorCanvas') errorCanvasRef?: ElementRef<HTMLCanvasElement>;

  private trendChart?: Chart;
  private objectChart?: Chart;
  private pathwayChart?: Chart;
  private errorChart?: Chart;
  private pendingChartFrame?: number;

  // ==========================================
  // REACTIVE STATE
  // ==========================================
  activeTab = signal<HistoryTab>('migrations');

  migrationLogs = signal<MigrationHistoryRecord[]>([]);
  validationLogs = signal<ValidationHistoryRecord[]>([]);
  analytics = signal<AnalyticsSummary | null>(null);

  isLoading = signal(true);
  isAnalyticsLoading = signal(true);
  errorMessage = signal<string | null>(null);
  analyticsErrorMessage = signal<string | null>(null);
  lastUpdated = signal<Date | null>(null);

  readonly kpiCards = computed<KpiCard[]>(() => {
    const analytics = this.analytics();
    if (!analytics) return [];
    const o = analytics.overview;
    return [
      {
        icon: 'icon-upload-cloud',
        label: 'Migrations Run',
        value: `${o.totalMigrations}`,
        sublabel: `${o.totalRecordsMigrated.toLocaleString()} records total`,
        accent: 'primary',
      },
      {
        icon: 'icon-check-circle',
        label: 'Success Rate',
        value: `${o.successRate}%`,
        sublabel: `${o.totalSuccess.toLocaleString()} succeeded`,
        accent: 'success',
      },
      {
        icon: 'icon-alert-circle',
        label: 'Failed Records',
        value: `${o.totalErrors.toLocaleString()}`,
        sublabel: 'across all migrations',
        accent: 'danger',
      },
      {
        icon: 'icon-check-square',
        label: 'Validation Runs',
        value: `${o.totalValidationRuns}`,
        sublabel: `${o.totalValidated.toLocaleString()} records checked`,
        accent: 'info',
      },
      {
        icon: 'icon-shield',
        label: 'Validation Pass Rate',
        value: `${o.validationPassRate}%`,
        sublabel: `${o.totalInvalid.toLocaleString()} invalid found`,
        accent: 'primary',
      },
      // {
      //   icon: 'icon-copy',
      //   label: 'Duplicates Caught',
      //   value: `${o.totalDuplicates.toLocaleString()}`,
      //   sublabel: 'during validation',
      //   accent: 'warning',
      // },
    ];
  });

  readonly hasChartData = computed<boolean>(() => {
    const a = this.analytics();
    if (!a) return false;
    return a.trend.length > 0 || a.byObject.length > 0 || a.byPathway.length > 0 || a.topErrors.length > 0;
  });

  readonly availableCRMs = [
    { id: 'zendesk', name: 'Zendesk' },
    { id: 'salesforce', name: 'Salesforce' },
    { id: 'hubspot', name: 'HubSpot' },
    { id: 'zoho', name: 'Zoho CRM' },
    { id: 'csv', name: 'CSV' },
  ];

  filters: HistoryFilters = {};

  private readonly crmColorMap: Record<string, string> = {
    salesforce: '#00A1E0',
    zendesk: '#17494D',
    hubspot: '#FF7A59',
    zoho: '#E42527',
    csv: '#6c757d',
  };

  private readonly chartPalette = [
    '#0d6efd', '#198754', '#fd7e14', '#6f42c1',
    '#20c997', '#dc3545', '#ffc107', '#0dcaf0',
    '#6610f2', '#d63384',
  ];

  ngOnInit(): void {
    this.fetchAll();
  }

  ngOnDestroy(): void {
    if (this.pendingChartFrame !== undefined) {
      cancelAnimationFrame(this.pendingChartFrame);
    }
    this.destroyCharts();
  }

  // ==========================================
  // DATA LOADING
  // ==========================================
  fetchAll(): void {
    this.fetchHistory();
    this.fetchAnalytics();
  }

  fetchHistory(): void {
    this.isLoading.set(true);
    this.errorMessage.set(null);

    forkJoin({
      migrations: this.migrationApi.getMigrationHistory(this.filters),
      validations: this.migrationApi.getValidationHistory(this.filters),
    }).subscribe({
      next: ({ migrations, validations }) => {
        this.migrationLogs.set(migrations.history || []);
        this.validationLogs.set(validations.history || []);
        this.isLoading.set(false);
        this.lastUpdated.set(new Date());
        this.reinitIcons();
      },
      error: (err) => {
        console.error('Failed to load history', err);
        this.errorMessage.set('Unable to load audit logs. Please try again later.');
        this.isLoading.set(false);
      }
    });
  }

  fetchAnalytics(): void {
    this.isAnalyticsLoading.set(true);
    this.analyticsErrorMessage.set(null);

    this.migrationApi.getAnalyticsSummary(this.filters).subscribe({
      next: (res) => {
        this.analytics.set(res);
        this.isAnalyticsLoading.set(false);

        afterNextRender(
          () => this.zone.runOutsideAngular(() => {
            if (this.pendingChartFrame !== undefined) {
              cancelAnimationFrame(this.pendingChartFrame);
            }
            this.pendingChartFrame = requestAnimationFrame(() => {
              this.pendingChartFrame = undefined;
              this.renderCharts();
            });
          }),
          { injector: this.injector }
        );
      },
      error: (err) => {
        console.error('Failed to load analytics summary', err);
        this.analyticsErrorMessage.set('Unable to load analytics right now.');
        this.isAnalyticsLoading.set(false);
      }
    });
  }

  applyFilters(): void {
    this.fetchAll();
  }

  resetFilters(): void {
    this.filters = {};
    this.fetchAll();
  }

  setTab(tab: HistoryTab): void {
    this.activeTab.set(tab);
    this.reinitIcons();
  }

  // ==========================================
  // DISPLAY HELPERS
  // ==========================================
  getCrmIcon(crmName: string | null | undefined): string {
    const crm = (crmName || '').toLowerCase();
    if (crm === 'salesforce') return 'icon-cloud text-primary';
    if (crm === 'zendesk') return 'icon-headphones text-success';
    if (crm === 'hubspot') return 'icon-share-2 text-warning';
    if (crm === 'zoho') return 'icon-layout text-info';
    if (crm === 'csv') return 'icon-file-text text-secondary';
    return 'icon-database text-dark';
  }

  getCrmColor(crmName: string | null | undefined): string {
    return this.crmColorMap[(crmName || '').toLowerCase()] || '#6c757d';
  }


  getCrmBadgeStyle(crmName: string | null | undefined): { [klass: string]: string } {
    const hex = this.getCrmColor(crmName);
    const { r, g, b } = this.hexToRgb(hex);
    return {
      'background-color': `rgba(${r}, ${g}, ${b}, 0.12)`,
      'color': hex,
      'border': `1px solid rgba(${r}, ${g}, ${b}, 0.35)`,
    };
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean, 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
  }

  successPct(successCount: number, totalRecords: number): number {
    if (!totalRecords) return 0;
    return Math.round((successCount / totalRecords) * 100);
  }

  topErrorCategories(summary: { category: string; count: number }[] | null | undefined, limit = 2): string {
    if (!summary || summary.length === 0) return '';
    return summary.slice(0, limit).map(s => `${s.category} (${s.count})`).join(', ');
  }

  private reinitIcons(): void {
    afterNextRender(
      () => this.zone.runOutsideAngular(() => {
        const featherLib = (window as any).feather;
        if (featherLib && typeof featherLib.replace === 'function') {
          featherLib.replace();
        }
      }),
      { injector: this.injector }
    );
  }

  // ==========================================
  // CHARTS
  // ==========================================
  private destroyCharts(): void {
    this.trendChart?.destroy();
    this.objectChart?.destroy();
    this.pathwayChart?.destroy();
    this.errorChart?.destroy();
    this.trendChart = this.objectChart = this.pathwayChart = this.errorChart = undefined;
  }

  private renderCharts(): void {
    const analytics = this.analytics();
    if (!analytics) return;
    this.destroyCharts();
    this.renderTrendChart(analytics);
    this.renderObjectChart(analytics);
    this.renderPathwayChart(analytics);
    this.renderErrorChart(analytics);
  }

  private renderTrendChart(analytics: AnalyticsSummary): void {
    const canvas = this.trendCanvasRef?.nativeElement;
    if (!canvas) return;
    const trend = analytics.trend;
    if (trend.length === 0) return;

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: trend.map(t => t.date),
        datasets: [
          { label: 'Migrated (Success)', data: trend.map(t => t.success), borderColor: '#198754', backgroundColor: 'rgba(25,135,84,0.12)', tension: 0.3, fill: true, pointRadius: 2 },
          { label: 'Migrated (Errors)', data: trend.map(t => t.errors), borderColor: '#dc3545', backgroundColor: 'rgba(220,53,69,0.08)', tension: 0.3, fill: true, pointRadius: 2 },
          { label: 'Validated (Valid)', data: trend.map(t => t.valid), borderColor: '#0d6efd', backgroundColor: 'rgba(13,110,253,0.08)', tension: 0.3, borderDash: [5, 4], pointRadius: 2 },
          { label: 'Validated (Invalid)', data: trend.map(t => t.invalid), borderColor: '#fd7e14', backgroundColor: 'rgba(253,126,20,0.08)', tension: 0.3, borderDash: [5, 4], pointRadius: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, font: { size: 11 } } },
          tooltip: { padding: 10, boxPadding: 4 },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 10, autoSkip: true }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    };

    this.trendChart = new Chart(canvas, config);
  }

  private renderObjectChart(analytics: AnalyticsSummary): void {
    const canvas = this.objectCanvasRef?.nativeElement;
    if (!canvas) return;
    const rows = analytics.byObject.slice(0, 8);
    if (rows.length === 0) return;

    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: rows.map(r => r.object),
        datasets: [
          { label: 'Success', data: rows.map(r => r.success), backgroundColor: '#198754', borderRadius: 4 },
          { label: 'Errors', data: rows.map(r => r.errors), backgroundColor: '#dc3545', borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, font: { size: 11 } } },
          tooltip: { padding: 10, boxPadding: 4 },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, maxRotation: 40, minRotation: 0 } },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    };

    this.objectChart = new Chart(canvas, config);
  }

  private renderPathwayChart(analytics: AnalyticsSummary): void {
    const canvas = this.pathwayCanvasRef?.nativeElement;
    if (!canvas) return;
    const rows = analytics.byPathway;
    if (rows.length === 0) return;

    const total = rows.reduce((sum, r) => sum + r.totalRecords, 0);

    const config: ChartConfiguration<'doughnut'> = {
      type: 'doughnut',
      data: {
        labels: rows.map(r => `${this.titleCasePipe.transform(r.sourceCrm)} \u2192 ${this.titleCasePipe.transform(r.targetCrm)}`),
        datasets: [{
          data: rows.map(r => r.totalRecords),
          backgroundColor: rows.map((_, i) => this.chartPalette[i % this.chartPalette.length]),
          borderWidth: 2,
          borderColor: '#ffffff',
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12, font: { size: 11 } } },
          tooltip: {
            padding: 10,
            boxPadding: 4,
            callbacks: {
              label: (ctx) => {
                const value = (ctx.parsed as number) ?? 0;
                const pct = total ? ((value / total) * 100).toFixed(1) : '0.0';
                return `${ctx.label}: ${value.toLocaleString()} records (${pct}%)`;
              },
            },
          },
        },
      },
    };

    this.pathwayChart = new Chart(canvas, config);
  }

  private renderErrorChart(analytics: AnalyticsSummary): void {
    const canvas = this.errorCanvasRef?.nativeElement;
    if (!canvas) return;
    const rows = analytics.topErrors;
    if (rows.length === 0) return;

    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: rows.map(r => r.category),
        datasets: [{ label: 'Occurrences', data: rows.map(r => r.count), backgroundColor: '#dc3545', borderRadius: 4, maxBarThickness: 28 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            padding: 10,
            boxPadding: 4,
            callbacks: {
              afterLabel: (ctx) => {
                const sample = rows[ctx.dataIndex]?.sample;
                return sample ? `e.g. "${sample}"` : '';
              },
            },
          },
        },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { display: false } },
          y: { grid: { display: false } },
        },
      },
    };

    this.errorChart = new Chart(canvas, config);
  }
}