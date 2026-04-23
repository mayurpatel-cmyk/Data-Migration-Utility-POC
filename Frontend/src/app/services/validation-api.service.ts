/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ValidationApiService {
  private http = inject(HttpClient);
  
  // URL matching your Node.js backend validation route
  private validateUrl = 'http://localhost:3000/api/validate-data';

  private getHeaders(): HttpHeaders {
    // Pull directly from the keys your AuthService uses (Mirroring MigrationService)
    const accessToken = localStorage.getItem('sf_token') || '';
    const instanceUrl = localStorage.getItem('sf_instance_url') || ''; 
    const email = localStorage.getItem('sf_user_email') || ''; 

    return new HttpHeaders({
      'user-email': email,
      'instanceurl': instanceUrl, 
      'accesstoken': accessToken  
    });
  }

  /**
   * Sends the raw data and mappings to the Node backend for validation
   * @param payload { records: any[], mappings: any[], dedupeKey: string }
   */
validateData(payload: any): Observable<any> {
    return this.http.post<any>(this.validateUrl, payload, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(
      timeout(120000) 
    );
  }
}