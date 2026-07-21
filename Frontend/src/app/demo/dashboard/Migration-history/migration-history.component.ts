import { Component, OnInit } from '@angular/core';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
import { MigrationApiService, MigrationHistoryRecord } from '../../../services/migration-history.service';
// Import your Shared AppCardComponent if it's standalone, or declare it in your module

@Component({
  selector: 'app-migration-history',
  standalone: true,
  imports: [CommonModule], 
  providers: [DatePipe, TitleCasePipe],
  templateUrl: './migration-history.component.html',
  styleUrls: []
})
export class MigrationHistoryComponent implements OnInit {
  historyLogs: MigrationHistoryRecord[] = [];
  isLoading: boolean = true;
  errorMessage: string | null = null;

  constructor(private migrationApi: MigrationApiService) {}

  ngOnInit(): void {
    this.fetchHistory();
  }

  fetchHistory(): void {
    this.isLoading = true;
    this.errorMessage = null;

    this.migrationApi.getMigrationHistory().subscribe({
      next: (res) => {
        if (res.success) {
          this.historyLogs = res.history;
        }
        this.isLoading = false;
      },
      error: (err) => {
        console.error('Failed to load migration history', err);
        this.errorMessage = 'Unable to load audit logs. Please try again later.';
        this.isLoading = false;
      }
    });
  }

  // Helper to format the CRM names and icons dynamically
  getCrmIcon(crmName: string): string {
    const crm = crmName?.toLowerCase();
    if (crm === 'salesforce') return 'icon-cloud text-primary';
    if (crm === 'zendesk') return 'icon-headphones text-success';
    if (crm === 'hubspot') return 'icon-share-2 text-warning';
    if (crm === 'zoho') return 'icon-layout text-info';
    if (crm === 'csv') return 'icon-file-text text-secondary';
    return 'icon-database text-dark';
  }
}