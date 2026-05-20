/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class MappingApiService {
  private http = inject(HttpClient);
  private baseUrl = 'http://localhost:8000/api'; // Point to your FastAPI backend port

  /**
   * Helper to compile all security tokens from local storage into headers
   */
  private getAuthHeaders(): HttpHeaders {
    return new HttpHeaders({
      'sf-token': localStorage.getItem('sf_token') || '',
      'sf-instance-url': localStorage.getItem('sf_instance_url') || '',
      'zd-token': localStorage.getItem('zd_token') || '',
      'zd-subdomain': localStorage.getItem('zd_subdomain') || '',
      'zoho-token': localStorage.getItem('zoho_token') || '',
      'zoho-region': localStorage.getItem('zoho_region') || ''
    });
  }

  /**
   * Fetch all supported objects/entities for a specific platform
   */
  getObjects(crmId: string): Observable<any[]> {
    return this.http.get<any[]>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/objects`, {
      headers: this.getAuthHeaders()
    }).pipe(timeout(30000));
  }

  /**
   * Fetch all schema fields for a specific object/entity
   */
  getFields(crmId: string, objectName: string): Observable<any> {
    return this.http.get<any>(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/fields/${objectName}`, {
      headers: this.getAuthHeaders()
    }).pipe(timeout(30000));
  }
}