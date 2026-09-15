import { Component, OnInit, OnDestroy, ViewChild, ElementRef, inject } from '@angular/core';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { Chart, registerables } from 'chart.js';
import {
  MigrationApiService,
  MigrationHistoryRecord,
  ValidationHistoryRecord,
  AnalyticsSummary,
  HistoryFilters,
} from '../../../services/migration-history.service';

Chart.register(...registerables);

type HistoryTab = 'migrations' | 'validations';

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

  @ViewChild('trendCanvas') trendCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('objectCanvas') objectCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('pathwayCanvas') pathwayCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('errorCanvas') errorCanvasRef?: ElementRef<HTMLCanvasElement>;

  private trendChart?: Chart;
  private objectChart?: Chart;
  private pathwayChart?: Chart;
  private errorChart?: Chart;

  activeTab: HistoryTab = 'migrations';

  migrationLogs: MigrationHistoryRecord[] = [];
  validationLogs: ValidationHistoryRecord[] = [];
  analytics: AnalyticsSummary | null = null;

  isLoading = true;
  isAnalyticsLoading = true;
  errorMessage: string | null = null;
  analyticsErrorMessage: string | null = null;

  readonly availableCRMs = [
    { id: 'zendesk', name: 'Zendesk' },
    { id: 'salesforce', name: 'Salesforce' },
    { id: 'hubspot', name: 'HubSpot' },
    { id: 'zoho', name: 'Zoho CRM' },
    { id: 'csv', name: 'CSV' },
  ];

  filters: HistoryFilters = {};

  ngOnInit(): void {
    this.fetchAll();
  }

  ngOnDestroy(): void {
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
    this.isLoading = true;
    this.errorMessage = null;

    forkJoin({
      migrations: this.migrationApi.getMigrationHistory(this.filters),
      validations: this.migrationApi.getValidationHistory(this.filters),
    }).subscribe({
      next: ({ migrations, validations }) => {
        this.migrationLogs = migrations.history || [];
        this.validationLogs = validations.history || [];
        this.isLoading = false;
      },
      error: (err) => {
        console.error('Failed to load history', err);
        this.errorMessage = 'Unable to load audit logs. Please try again later.';
        this.isLoading = false;
      }
    });
  }

  fetchAnalytics(): void {
    this.isAnalyticsLoading = true;
    this.analyticsErrorMessage = null;

    this.migrationApi.getAnalyticsSummary(this.filters).subscribe({
      next: (res) => {
        this.analytics = res;
        this.isAnalyticsLoading = false;

        setTimeout(() => this.renderCharts(), 0);
      },
      error: (err) => {
        console.error('Failed to load analytics summary', err);
        this.analyticsErrorMessage = 'Unable to load analytics right now.';
        this.isAnalyticsLoading = false;
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
    this.activeTab = tab;
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

  topErrorCategories(summary: { category: string; count: number }[] | null | undefined, limit = 2): string {
    if (!summary || summary.length === 0) return '';
    return summary.slice(0, limit).map(s => `${s.category} (${s.count})`).join(', ');
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
    if (!this.analytics) return;
    this.destroyCharts();
    this.renderTrendChart();
    this.renderObjectChart();
    this.renderPathwayChart();
    this.renderErrorChart();
  }

  private renderTrendChart(): void {
    const canvas = this.trendCanvasRef?.nativeElement;
    if (!canvas || !this.analytics) return;
    const trend = this.analytics.trend;

    this.trendChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: trend.map(t => t.date),
        datasets: [
          { label: 'Migrated (Success)', data: trend.map(t => t.success), borderColor: '#198754', backgroundColor: 'rgba(25,135,84,0.1)', tension: 0.3 },
          { label: 'Migrated (Errors)', data: trend.map(t => t.errors), borderColor: '#dc3545', backgroundColor: 'rgba(220,53,69,0.1)', tension: 0.3 },
          { label: 'Validated (Valid)', data: trend.map(t => t.valid), borderColor: '#0d6efd', backgroundColor: 'rgba(13,110,253,0.1)', tension: 0.3, borderDash: [5, 4] },
          { label: 'Validated (Invalid)', data: trend.map(t => t.invalid), borderColor: '#fd7e14', backgroundColor: 'rgba(253,126,20,0.1)', tension: 0.3, borderDash: [5, 4] },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  private renderObjectChart(): void {
    const canvas = this.objectCanvasRef?.nativeElement;
    if (!canvas || !this.analytics) return;
    const rows = this.analytics.byObject.slice(0, 8);

    this.objectChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.object),
        datasets: [
          { label: 'Success', data: rows.map(r => r.success), backgroundColor: '#198754' },
          { label: 'Errors', data: rows.map(r => r.errors), backgroundColor: '#dc3545' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
      },
    });
  }

  private renderPathwayChart(): void {
    const canvas = this.pathwayCanvasRef?.nativeElement;
    if (!canvas || !this.analytics) return;
    const rows = this.analytics.byPathway;

    this.pathwayChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: rows.map(r => `${r.sourceCrm} \u2192 ${r.targetCrm}`),
        datasets: [{
          data: rows.map(r => r.totalRecords),
          backgroundColor: ['#0d6efd', '#198754', '#fd7e14', '#6f42c1', '#20c997', '#dc3545', '#ffc107', '#6c757d'],
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
      },
    });
  }

  private renderErrorChart(): void {
    const canvas = this.errorCanvasRef?.nativeElement;
    if (!canvas || !this.analytics) return;
    const rows = this.analytics.topErrors;

    this.errorChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.category),
        datasets: [{ label: 'Occurrences', data: rows.map(r => r.count), backgroundColor: '#dc3545' }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } },
      },
    });
  }
}