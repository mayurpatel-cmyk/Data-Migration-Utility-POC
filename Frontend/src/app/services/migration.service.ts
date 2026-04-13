/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map, tap } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:3000/api/sf';
  private migrateUrl = 'http://localhost:3000/api/migrate-data';

  // private getHeaders(): HttpHeaders {
  //   const userData = JSON.parse(localStorage.getItem('user_data') || '{}');

  //   return new HttpHeaders({
  //     'user-email': userData.email || '',
  //     'instanceurl': userData.instanceUrl || '',
  //     'accesstoken': userData.accessToken || ''
  //   });
  // }
  private getHeaders(): HttpHeaders {
  // 1. Grab the individual strings we saved in DefaultComponent
  const token = localStorage.getItem('sf_token') || '';
  const instanceUrl = localStorage.getItem('sf_instance_url') || '';

  // Note: Since Salesforce OAuth redirects don't always include the email,
  // we'll default to an empty string if it's not found.
  const email = localStorage.getItem('sf_user_email') || '';

  // 2. Return the headers using the keys your Backend expects
  return new HttpHeaders({
    'accesstoken': token,
    'instanceurl': instanceUrl,
    'user-email': email
  });
}

  getAllObjects(): Observable<any[]> {
    return this.http.get<{success: boolean, data: any[]}>(`${this.apiUrl}/all-objects`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      map(response => response.data)
    );
  }

  getObjectFields(objectName: string): Observable<any[]> {
    return this.http.get<any>(`${this.apiUrl}/fields/${objectName}`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap(rawResponse => console.log('RAW BACKEND RESPONSE:', rawResponse)),
      map(response => {
        if (response.fields) return response.fields;
        if (response.data) return response.data;
        if (Array.isArray(response)) return response;
        return [];
      })
    );
  }

  migrateData(payload: any): Observable<any> {
    return this.http.post<any>(this.migrateUrl, payload, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }
}
