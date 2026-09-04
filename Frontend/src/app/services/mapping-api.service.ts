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
  private baseUrl = environment.apiUrl ? `${environment.apiUrl}/api` : 'http://localhost:8000/api';

  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('supabase_token') || '';
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  getObjects(crmId: string, role: 'source' | 'target'): Observable<any[]> {
    const params = new HttpParams().set('role', role);
    
    return this.http.get<any[]>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/objects`, {
      headers: this.getAuthHeaders(),
      params: params
    }).pipe(timeout(30000));
  }


  getFields(crmId: string, objectName: string, role: 'source' | 'target'): Observable<any> {
    const params = new HttpParams().set('role', role);
    
    return this.http.get<any>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/fields/${objectName}`, {
      headers: this.getAuthHeaders(),
      params: params
    }).pipe(timeout(30000));
  }

  getAiAutoMapping(sourceFields: any[], targetFields: any[]): Observable<any> {
  return this.http.post<any>(
    `${this.baseUrl}/metadata/ai-auto-map`, 
    {
      sourceFields: sourceFields,
      targetFields: targetFields
    },
    {
      headers: this.getAuthHeaders()
    }
  );
}
}