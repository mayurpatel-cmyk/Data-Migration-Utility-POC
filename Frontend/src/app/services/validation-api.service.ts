/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ValidationApiService {
  private http = inject(HttpClient);
  
  // FIXED: Pointing directly to the Python backend on port 5000
  private validateUrl = 'http://localhost:5000/api/python/validate';
  private extractHeadersUrl = 'http://localhost:5000/api/python/extract-headers';
  private revalidateUrl = 'http://localhost:5000/api/python/revalidate';

  private getHeaders(): HttpHeaders {
    // Pull directly from the keys your AuthService uses
    const accessToken = localStorage.getItem('sf_token') || '';
    const instanceUrl = localStorage.getItem('sf_instance_url') || ''; 
    const email = localStorage.getItem('sf_user_email') || ''; 

    // Notice we DO NOT set 'Content-Type': 'multipart/form-data'. 
    // The browser must do this automatically to set the correct boundary tags!
    return new HttpHeaders({
      'user-email': email,
      'instanceurl': instanceUrl, 
      'accesstoken': accessToken  
    });
  }

  /**
   * Fast file read just to extract columns and sheets (Prevents browser crash)
   * @param formData FormData containing only the 'file'
   */
  extractHeaders(formData: FormData): Observable<any> {
    return this.http.post<any>(this.extractHeadersUrl, formData, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(
      timeout(60000) // 1 minute timeout for extraction
    );
  }

  /**
   * Sends the physical file and mappings to the backend for chunked validation
   * @param formData FormData containing 'file' and 'config'
   */
  validateData(formData: FormData): Observable<any> {
    return this.http.post<any>(this.validateUrl, formData, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(
      timeout(300000) // Increased to 5 minutes for massive data payloads
    );
  }

  /**
   * Sends a small JSON payload for re-validating specific fixed rows
   * @param payload Standard JSON object
   */
  revalidateData(payload: any): Observable<any> {
    return this.http.post<any>(this.revalidateUrl, payload, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(
      timeout(60000) // 1 minute is plenty for a few rows
    );
  }
}