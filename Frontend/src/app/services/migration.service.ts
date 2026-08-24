import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl ? `${environment.apiUrl}/api` : 'http://localhost:8000/api';

  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('supabase_token') || '';
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  getAllObjects(crmId: string, role: 'source' | 'target' = 'target'): Observable<any[]> {
    const params = new HttpParams().set('role', role);
    return this.http.get<any[]>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/objects`, { 
      headers: this.getAuthHeaders(),
      params: params
    }).pipe(timeout(30000));
  }

  getObjectFields(crmId: string, objectName: string, role: 'source' | 'target' = 'target'): Observable<any> {
    const params = new HttpParams().set('role', role);
    return this.http.get<any>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/fields/${objectName}`, {
      headers: this.getAuthHeaders(),
      params: params
    }).pipe(timeout(30000));
  }

  migrateDataViaHttp(payload: any): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/migration/migrate-data`, payload, {
      headers: this.getAuthHeaders()
    });
  }
}