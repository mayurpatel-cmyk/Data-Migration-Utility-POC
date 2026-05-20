/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class CrmAuthService {
  private http = inject(HttpClient);
  
  // Point this to your NODE.JS Gateway auth routes
  private authBaseUrl = 'http://localhost:8000/api/auth';

  // ==========================================
  // 1. OAUTH LOGIN (Browser Redirect)
  // ==========================================
  /**
   * Redirects the user's browser to the backend OAuth login endpoint.
   * * @param crmId - 'salesforce', 'zendesk', 'zoho', etc.
   * @param side - 'source' (where data comes from) or 'target' (where data goes)
   * @param subdomain - Required for CRMs like Zendesk (e.g., 'sureshift')
   */
  connectCrm(crmId: string, side: 'source' | 'target', subdomain?: string): void {
    const safeCrmId = crmId.toLowerCase();
    let loginUrl = `${this.authBaseUrl}/${safeCrmId}/login?side=${side}`;
    
    if (subdomain) {
      // encodeURIComponent prevents special characters from breaking the URL
      loginUrl += `&subdomain=${encodeURIComponent(subdomain)}`;
    }

    // We do NOT use this.http.get() for this. 
    // OAuth requires a full browser context switch to the CRM's login screen.
    window.location.href = loginUrl;
  }

  // ==========================================
  // 2. CHECK CONNECTION STATUS (API Call)
  // ==========================================
  /**
   * Optional: If you have an endpoint to check if the stored token is still valid.
   */
  checkConnectionStatus(crmId: string): Observable<any> {
    const safeCrmId = crmId.toLowerCase();
    
    return this.http.get<any>(`${this.authBaseUrl}/${safeCrmId}/status`, {
      headers: this.getAuthHeaders(),
      withCredentials: true
    }).pipe(timeout(15000));
  }

  // ==========================================
  // 3. TOKEN MANAGEMENT (Local Storage)
  // ==========================================
  /**
   * Utility to fetch currently saved tokens.
   */
  private getAuthHeaders(): HttpHeaders {
    return new HttpHeaders({
      'sf-accesstoken': localStorage.getItem('sf_token') || '',
      'zd-accesstoken': localStorage.getItem('zd_token') || '',
      'zoho-accesstoken': localStorage.getItem('zoho_token') || ''
    });
  }

  /**
   * Call this from your Component when the URL callback returns successfully.
   */
  saveConnectionDetails(crmId: string, tokens: any): void {
    const safeCrmId = crmId.toLowerCase();

    if (safeCrmId === 'salesforce') {
      localStorage.setItem('sf_token', tokens.access_token || '');
      localStorage.setItem('sf_instance_url', tokens.instance_url || '');
    } else if (safeCrmId === 'zendesk') {
      localStorage.setItem('zd_token', tokens.access_token || '');
      localStorage.setItem('zd_subdomain', tokens.subdomain || '');
    } else if (safeCrmId === 'zoho') {
      localStorage.setItem('zoho_token', tokens.access_token || '');
      localStorage.setItem('zoho_region', tokens.region || '');
    }
  }
  
  disconnectCrm(crmId: string): void {
    const safeCrmId = crmId.toLowerCase();

    if (safeCrmId === 'salesforce') {
      localStorage.removeItem('sf_token');
      localStorage.removeItem('sf_instance_url');
      localStorage.removeItem('sf_user_email');
    } else if (safeCrmId === 'zendesk') {
      localStorage.removeItem('zd_token');
      localStorage.removeItem('zd_subdomain');
    }
  }
}