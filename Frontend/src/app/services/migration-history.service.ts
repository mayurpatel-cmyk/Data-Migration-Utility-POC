import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';

export interface ErrorSummaryItem {
  category: string;
  count: number;
  sample: string | null;
}

export interface MigrationHistoryRecord {
  id: string;
  session_id: string;
  created_at: string;
  source_crm: string;
  target_crm: string;
  target_object: string;
  total_records: number;
  success_count: number;
  error_count: number;
  pdf_url: string | null;
  success_csv_url: string | null;
  error_csv_url: string | null;
  error_summary?: ErrorSummaryItem[] | null;
  migration_mode?: string | null;
   source_mode?: string | null;
}

export interface ValidationHistoryRecord {
  id: string;
  session_id: string;
  created_at: string;
  updated_at?: string;
  source_crm: string;
  target_crm: string | null;
  target_object: string;
  total_records: number;
  valid_count: number;
  invalid_count: number;
  duplicate_count: number;
  invalid_csv_url: string | null;
  valid_csv_url: string | null;
  error_summary?: ErrorSummaryItem[] | null;
}

export interface AnalyticsOverview {
  totalMigrations: number;
  totalRecordsMigrated: number;
  totalSuccess: number;
  totalErrors: number;
  successRate: number;
  totalValidationRuns: number;
  totalValidated: number;
  totalValid: number;
  totalInvalid: number;
  totalDuplicates: number;
  validationPassRate: number;
}

export interface ByObjectStat {
  object: string;
  migrations: number;
  totalRecords: number;
  success: number;
  errors: number;
  successRate: number;
}

export interface ByPathwayStat {
  sourceCrm: string;
  targetCrm: string;
  migrations: number;
  totalRecords: number;
  success: number;
  errors: number;
  successRate: number;
}

export interface TrendPoint {
  date: string;
  migrations: number;
  success: number;
  errors: number;
  validationRuns: number;
  valid: number;
  invalid: number;
}

export interface ValidationByObjectStat {
  object: string;
  totalValidated: number;
  valid: number;
  invalid: number;
  duplicates: number;
  passRate: number;
}

export interface AnalyticsSummary {
  overview: AnalyticsOverview;
  byObject: ByObjectStat[];
  byPathway: ByPathwayStat[];
  trend: TrendPoint[];
  topErrors: ErrorSummaryItem[];
  validationByObject: ValidationByObjectStat[];
}

export interface HistoryFilters {
  sourceCrm?: string;
  targetCrm?: string;
  targetObject?: string;
  startDate?: string;
  endDate?: string;
}

@Injectable({ providedIn: 'root' })
export class MigrationApiService {

  private baseUrl = environment.apiUrl ? `${environment.apiUrl}/api` : 'http://localhost:8000/api';

  constructor(private http: HttpClient) {}

  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('supabase_token') || '';
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  private buildParams(filters?: HistoryFilters): HttpParams {
    let params = new HttpParams();
    if (!filters) return params;
    if (filters.sourceCrm) params = params.set('source_crm', filters.sourceCrm);
    if (filters.targetCrm) params = params.set('target_crm', filters.targetCrm);
    if (filters.targetObject) params = params.set('target_object', filters.targetObject);
    if (filters.startDate) params = params.set('start_date', filters.startDate);
    if (filters.endDate) params = params.set('end_date', filters.endDate);
    return params;
  }

  getMigrationHistory(filters?: HistoryFilters): Observable<{ success: boolean; history: MigrationHistoryRecord[] }> {
    return this.http.get<{ success: boolean; history: MigrationHistoryRecord[] }>(
      `${this.baseUrl}/migration-history`,
      { params: this.buildParams(filters),headers: this.getAuthHeaders() }
    );
  }

  getValidationHistory(filters?: HistoryFilters): Observable<{ success: boolean; history: ValidationHistoryRecord[] }> {
    return this.http.get<{ success: boolean; history: ValidationHistoryRecord[] }>(
      `${this.baseUrl}/validation-history`,
      { params: this.buildParams(filters),headers: this.getAuthHeaders() }
    );
  }

  getAnalyticsSummary(filters?: HistoryFilters): Observable<{ success: boolean } & AnalyticsSummary> {
    return this.http.get<{ success: boolean } & AnalyticsSummary>(
      `${this.baseUrl}/analytics/summary`,
      { params: this.buildParams(filters),headers: this.getAuthHeaders()}
    );
  }
}