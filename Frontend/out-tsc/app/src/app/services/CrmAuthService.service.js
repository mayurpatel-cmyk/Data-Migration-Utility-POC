import { __decorate } from "tslib";
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
let CrmAuthService = class CrmAuthService {
    constructor() {
        this.http = inject(HttpClient);
        // Point to your FastAPI backend base URL
        this.apiBaseUrl = 'http://localhost:8000/api/crm';
    }
    // =========================================================
    // HELPER: DYNAMIC TOKEN HUNTER
    // =========================================================
    /**
     * Scans local storage for the Supabase session and builds the Authorization header.
     */
    getAuthHeaders() {
        // We now know exactly where your auth.service.ts puts the token!
        const token = localStorage.getItem('supabase_token') || '';
        // Attach the exact token FastAPI is waiting for
        return new HttpHeaders().set('Authorization', `Bearer ${token}`);
    }
    // =========================================================
    // 1. FETCH ACTIVE CONNECTIONS FROM DATABASE
    // =========================================================
    getUserConnections() {
        return this.http.get(`${this.apiBaseUrl}/connections`, {
            headers: this.getAuthHeaders()
        });
    }
    // =========================================================
    // 2. OAUTH LOGIN GENERATION & REDIRECT 
    // =========================================================
    connectCrm(crmId, side, subdomain, region, environment = 'production') {
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
        this.http.get(requestUrl, { headers: this.getAuthHeaders() }).subscribe({
            next: (response) => {
                if (response?.url) {
                    // Force the browser to leave Angular and hit the CRM login screen
                    window.location.href = response.url;
                }
                else {
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
    disconnectCrm(side) {
        return this.http.delete(`${this.apiBaseUrl}/connections/${side}`, {
            headers: this.getAuthHeaders()
        });
    }
};
CrmAuthService = __decorate([
    Injectable({
        providedIn: 'root'
    })
], CrmAuthService);
export { CrmAuthService };
//# sourceMappingURL=CrmAuthService.service.js.map