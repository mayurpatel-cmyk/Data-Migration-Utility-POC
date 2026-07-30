import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root'
})
export class ValidationApiService {
  private http = inject(HttpClient);
  
  // Point to FastAPI
  private baseUrl = environment.apiUrl ? `${environment.apiUrl}/api/python` : 'http://localhost:8000/api/python';

  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('supabase_token') || '';
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  extractHeaders(formData: FormData): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/extract-headers`, formData, {
      headers: this.getAuthHeaders()
    }).pipe(timeout(60000));
  }

  validateData(formData: FormData): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/validate`, formData, {
      headers: this.getAuthHeaders()
    }).pipe(timeout(300000));
  }

  revalidateData(payload: any): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/revalidate`, payload, {
      headers: this.getAuthHeaders()
    }).pipe(timeout(60000));
  }
}