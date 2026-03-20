import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private apiUrl = 'http://localhost:3000/api/migration';

  constructor(private http: HttpClient) {}

  // Helper to get headers with the JWT token
  private getHeaders(): HttpHeaders {
    const token = localStorage.getItem('token');
    console.log("Token being sent:", token);

    
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
  }

  /**
   * 1. Fetch all Salesforce Objects (for your dropdown)
   */
  getSFObjects(): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/objects`, {
      headers: this.getHeaders()
    });
  }

  /**
   * 2. Fetch all Fields for a specific Object (for your mapping table)
   * @param objectName e.g., 'Lead' or 'Account'
   */
  getSFFields(objectName: string): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/fields/${objectName}`, {
      headers: this.getHeaders()
    });
  }

  /**
   * 3. Updated Upload Data
   * Now includes the 'mappings' object from the UI
   */
  uploadData(file: File, payload: any): Observable<any> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('operation', payload.operation);
    formData.append('objectName', payload.objectName);
    formData.append('externalId', payload.externalId || '');

    // IMPORTANT: Send the field mapping as a stringified JSON
    // Format: { "Zoho_Column_Name": "Salesforce_Field_API_Name" }
    formData.append('mappings', JSON.stringify(payload.mappings));

    return this.http.post(`${this.apiUrl}/upload`, formData, {
      headers: this.getHeaders()
    });
  }
}
