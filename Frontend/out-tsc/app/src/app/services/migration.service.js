import { __decorate } from "tslib";
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { timeout } from 'rxjs';
import { environment } from 'src/environments/environment';
let MigrationService = class MigrationService {
    constructor() {
        this.http = inject(HttpClient);
        // Point to the Python FastAPI backend
        this.baseUrl = environment.apiUrl ? `${environment.apiUrl}/api` : 'http://localhost:8000/api';
    }
    // ONLY send the Supabase token. Let Python handle the CRM tokens.
    getAuthHeaders() {
        const token = localStorage.getItem('supabase_token') || '';
        return new HttpHeaders({
            'Authorization': `Bearer ${token}`
        });
    }
    getAllObjects(crmId, role = 'target') {
        const params = new HttpParams().set('role', role);
        return this.http.get(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/objects`, {
            headers: this.getAuthHeaders(),
            params: params
        }).pipe(timeout(30000));
    }
    getObjectFields(crmId, objectName, role = 'target') {
        const params = new HttpParams().set('role', role);
        return this.http.get(`${this.baseUrl}/metadata/${crmId.toLowerCase()}/fields/${objectName}`, {
            headers: this.getAuthHeaders(),
            params: params
        }).pipe(timeout(30000));
    }
    // NOTE: Your Python backend uses WebSockets for migration (/ws/migrate).
    // If you want to use HTTP instead, you will need a POST route in Python.
    migrateDataViaHttp(payload) {
        return this.http.post(`${this.baseUrl}/migration/migrate-data`, payload, {
            headers: this.getAuthHeaders()
        });
    }
};
MigrationService = __decorate([
    Injectable({
        providedIn: 'root'
    })
], MigrationService);
export { MigrationService };
//# sourceMappingURL=migration.service.js.map