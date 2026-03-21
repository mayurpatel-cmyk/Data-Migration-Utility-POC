/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map,tap } from 'rxjs';


@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:3000/api/sf'; 
  private apiUrl2 = 'http://localhost:3000/api/migrate';

 private getHeaders(): HttpHeaders {
    const userData = JSON.parse(localStorage.getItem('user_data') || '{}');
    
    return new HttpHeaders({
      'user-email': userData.email || '',
      'instanceurl': userData.instanceUrl || '', 
      'accesstoken': userData.accessToken || ''  
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
      // This prints EXACTLY what Node.js sent back before Angular touches it
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
    return this.http.post<any>(`${this.apiUrl2}/migrate-data`, payload, {
      headers: this.getHeaders(),
      withCredentials: true 
    });
}
}