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

 private getHeaders(): HttpHeaders {
    // Grab the user data that your AuthService saved during login
    const userData = JSON.parse(localStorage.getItem('user_data') || '{}');
    
    return new HttpHeaders({
      'user-email': userData.email || '',
      // Add the two headers your Node middleware is begging for!
      'instanceurl': userData.instanceUrl || '', 
      'accesstoken': userData.accessToken || ''  
    });
  }

  // 1. Updated URL to match '/standard-objects'
  getAllObjects(): Observable<any[]> {
    return this.http.get<{success: boolean, data: any[]}>(`${this.apiUrl}/all-objects`, { 
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      map(response => response.data) 
    );
  }

  // 2. Updated URL to match '/fields/:objectName'
getObjectFields(objectName: string): Observable<any[]> {
    return this.http.get<any>(`${this.apiUrl}/fields/${objectName}`, {
      headers: this.getHeaders(),
      withCredentials: true 
    }).pipe(
      // 1. This prints EXACTLY what Node.js sent back before Angular touches it
      tap(rawResponse => console.log('RAW BACKEND RESPONSE:', rawResponse)),
      
      // 2. This safely grabs the fields, even if the backend named the property 'data' instead
      map(response => {
        if (response.fields) return response.fields;
        if (response.data) return response.data;
        if (Array.isArray(response)) return response; // Just in case it sent a raw array!
        return []; // If all else fails, return an empty array so the UI doesn't crash
      })
    );
  }
}