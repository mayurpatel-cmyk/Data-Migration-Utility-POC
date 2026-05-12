/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ValidationApiService {
  private http = inject(HttpClient);
  
  // FIX: Point these to your NODE.JS Gateway, NOT Python. 
  // Adjust the port (3000) and base path to match your Node backend.
  private validateUrl = 'http://localhost:3000/api/validation/validate-data';
  private extractHeadersUrl = 'http://localhost:3000/api/validation/extract-headers';
  private revalidateUrl = 'http://localhost:3000/api/validation/revalidate';

  private getHeaders(): HttpHeaders {
    const accessToken = localStorage.getItem('sf_token') || '';
    const instanceUrl = localStorage.getItem('sf_instance_url') || ''; 
    const email = localStorage.getItem('sf_user_email') || ''; 

    return new HttpHeaders({
      'user-email': email,
      'instanceurl': instanceUrl, 
      'accesstoken': accessToken  
    });
  }

  extractHeaders(formData: FormData): Observable<any> {
    return this.http.post<any>(this.extractHeadersUrl, formData, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(timeout(60000));
  }

  validateData(formData: FormData): Observable<any> {
    return this.http.post<any>(this.validateUrl, formData, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(timeout(300000));
  }

  revalidateData(payload: any): Observable<any> {
    return this.http.post<any>(this.revalidateUrl, payload, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(timeout(60000));
  }
}