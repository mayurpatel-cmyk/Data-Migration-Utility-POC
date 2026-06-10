import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface CrmConnection {
  crm_type: string;
  connection_role: 'source' | 'target';
  subdomain?: string;
  region?: string;
  instance_url?: string;
}

@Injectable({
  providedIn: 'root'
})
export class CrmAuthService {
  private http = inject(HttpClient);
  
  // Point to your FastAPI backend base URL
  private apiBaseUrl = 'http://localhost:8000/api/crm';

  // =========================================================
  // 1. FETCH ACTIVE CONNECTIONS FROM DATABASE
  // =========================================================
  /**
   * Retrieves the current user's saved connections from Supabase via Python.
   * Attached Authorization headers are handled automatically by the Interceptor.
   */
  getUserConnections(): Observable<CrmConnection[]> {
    return this.http.get<CrmConnection[]>(`${this.apiBaseUrl}/connections`);
  }

  // =========================================================
  // 2. OAUTH LOGIN GENERATION & REDIRECT (Secure Handshake)
  // =========================================================
  /**
   * Requests an authorized OAuth redirection path from the Python API layer.
   * Automatically falls back to localized query parameters depending on CRM requirements.
   */
  connectCrm(crmId: string, side: 'source' | 'target', subdomain?: string, region?: string): void {
    const safeCrmId = crmId.toLowerCase();
    
    // Construct the backend endpoint URL to request the login link
    let requestUrl = `${this.apiBaseUrl}/auth/${safeCrmId}/login?side=${side}`;

    if (subdomain) {
      requestUrl += `&subdomain=${encodeURIComponent(subdomain)}`;
    }
    if (safeCrmId === 'zoho' && region) {
      requestUrl += `&region=${encodeURIComponent(region)}`;
    }

    // Securely fetch the generated OAuth URL from the backend
    this.http.get<{ url: string }>(requestUrl).subscribe({
      next: (response) => {
        if (response?.url) {
          // Perform the browser context switch to the CRM login screen
          window.location.href = response.url;
        } else {
          console.error(`Backend failed to generate a valid OAuth URL for ${crmId}.`);
        }
      },
      error: (err) => {
        console.error(`Failed to initialize ${crmId} authentication engine path:`, err);
      }
    });
  }

  // =========================================================
  // 3. DISCONNECT (Delete from Database)
  // =========================================================
  /**
   * Drops a specific connection slot profile data out of your Supabase records table.
   */
  disconnectCrm(side: 'source' | 'target'): Observable<any> {
    return this.http.delete(`${this.apiBaseUrl}/connections/${side}`);
  }
}