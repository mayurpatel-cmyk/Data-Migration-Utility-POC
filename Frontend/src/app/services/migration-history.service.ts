import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface MigrationHistoryRecord {
  id: string;
  session_id: string;
  source_crm: string;
  target_crm: string;
  target_object: string;
  total_records: number;
  success_count: number;
  error_count: number;
  pdf_url: string;
  success_csv_url: string;
  error_csv_url: string;
  status: string;
  created_at: string;
}

@Injectable({
  providedIn: 'root'
})
export class MigrationApiService {
  private baseUrl = 'http://localhost:8000/api'; 

  constructor(private http: HttpClient) {}

 private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('supabase_token') || '';
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  getMigrationHistory(): Observable<{ success: boolean; history: MigrationHistoryRecord[] }> {
    return this.http.get<{ success: boolean; history: MigrationHistoryRecord[] }>(
      `${this.baseUrl}/migration-history`, 
      { headers: this.getAuthHeaders() } 
    );
  }
}