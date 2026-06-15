/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root'
})
export class MappingApiService {
  private http = inject(HttpClient);
  // Uses environment URL if available, otherwise falls back to localhost
  private baseUrl = environment.apiUrl ? `${environment.apiUrl}/api` : 'http://localhost:8000/api';

  /**
   * SECURITY UPGRADE: We ONLY send the Supabase token now.
   * The backend will safely look up the CRM tokens in the database.
   */
  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('supabase_token') || '';
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  /**
   * Fetch all supported objects/entities for a specific platform
   * Added 'role' parameter so the backend knows which slot to look up in the DB
   */
  getObjects(crmId: string, role: 'source' | 'target'): Observable<any[]> {
    const params = new HttpParams().set('role', role);

    return this.http.get<any[]>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/objects`, {
      headers: this.getAuthHeaders(),
      params: params
    }).pipe(timeout(30000));
  }

  /**
   * Fetch all schema fields for a specific object/entity
   * Added 'role' parameter so the backend knows which slot to look up in the DB
   */
  getFields(crmId: string, objectName: string, role: 'source' | 'target'): Observable<any> {
    const params = new HttpParams().set('role', role);

    return this.http.get<any>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/fields/${objectName}`, {
      headers: this.getAuthHeaders(),
      params: params
    }).pipe(timeout(30000));
  }
}
