import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface CrmConnection {
  crm_type: string;
  connection_role: 'source' | 'target';
  subdomain?: string;
  region?: string;
  instance_url?: string;
  environment?: string;
}

@Injectable({
  providedIn: 'root'
})
export class CrmAuthService {
  private http = inject(HttpClient);
  
  // Point to your FastAPI backend base URL
  private apiBaseUrl = 'http://localhost:8000/api/crm';

  // =========================================================
  // HELPER: DYNAMIC TOKEN HUNTER
  // =========================================================
  /**
   * Scans local storage for the Supabase session and builds the Authorization header.
   */
private getAuthHeaders(): HttpHeaders {
    // We now know exactly where your auth.service.ts puts the token!
    const token = localStorage.getItem('supabase_token') || '';

    // 🚨 DEBUG PRINTS 🚨
    console.log('--- ANGULAR TOKEN CHECK ---');
    if (token) {
      console.log(`✅ Token Found! Length: ${token.length}. First 15 chars: ${token.substring(0, 15)}...`);
    } else {
      console.error('❌ NO TOKEN FOUND IN LOCAL STORAGE! You are likely not logged in.');
    }

    // Attach the exact token FastAPI is waiting for
    return new HttpHeaders().set('Authorization', `Bearer ${token}`);
  }

  // =========================================================
  // 1. FETCH ACTIVE CONNECTIONS FROM DATABASE
  // =========================================================
  getUserConnections(): Observable<CrmConnection[]> {
    return this.http.get<CrmConnection[]>(`${this.apiBaseUrl}/connections`, { 
      headers: this.getAuthHeaders() 
    });
  }

  // =========================================================
  // 2. OAUTH LOGIN GENERATION & REDIRECT 
  // =========================================================
  connectCrm(crmId: string, side: 'source' | 'target', subdomain?: string, region?: string, environment: string = 'production'): void {
    const safeCrmId = crmId.toLowerCase();
    
    let requestUrl = `${this.apiBaseUrl}/auth/${safeCrmId}/login?side=${side}`;

    if (subdomain) {
      requestUrl += `&subdomain=${encodeURIComponent(subdomain)}`;
    }
    if (safeCrmId === 'zoho' && region) {
      requestUrl += `&region=${encodeURIComponent(region)}`;
    }
    if (safeCrmId === 'salesforce') {
      requestUrl += `&environment=${encodeURIComponent(environment)}`; // <-- ADD THIS
    }

    // Securely fetch the URL using the authorization headers
    this.http.get<{ url: string }>(requestUrl, { headers: this.getAuthHeaders() }).subscribe({
      next: (response) => {
        if (response?.url) {
          // Force the browser to leave Angular and hit the CRM login screen
          window.location.href = response.url;
        } else {
          console.error(`Backend failed to generate a valid OAuth URL for ${crmId}.`);
        }
      },
      error: (err) => {
        console.error(`Failed to initialize ${crmId} authentication path:`, err);
      }
    });
  }

  // =========================================================
  // 3. DISCONNECT (Delete from Database)
  // =========================================================
  disconnectCrm(side: 'source' | 'target'): Observable<any> {
    return this.http.delete(`${this.apiBaseUrl}/connections/${side}`, { 
      headers: this.getAuthHeaders() 
    });
  }
}