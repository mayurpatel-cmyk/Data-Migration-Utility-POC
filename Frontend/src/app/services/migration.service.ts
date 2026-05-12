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

 private getHeaders(): HttpHeaders {
  // Pull directly from the new keys your AuthService uses
  const accessToken = localStorage.getItem('sf_token') || '';
  const instanceUrl = localStorage.getItem('sf_instance_url') || ''; 
  
  // Note: Your OAuth flow doesn't seem to save an email to local storage anymore.
  // I am sending a blank string here just in case your Node backend expects the header to exist.
  const email = localStorage.getItem('sf_user_email') || ''; 

  // DEBUG LOG
  console.log('🛡️ Auth Headers Check:', { 
      hasInstanceUrl: !!instanceUrl, 
      hasToken: !!accessToken 
  });

  return new HttpHeaders({
    'user-email': email,
    'instanceurl': instanceUrl, 
    'accesstoken': accessToken  
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
      tap(rawResponse => console.log(`RAW BACKEND RESPONSE for ${objectName}:`, rawResponse)),
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