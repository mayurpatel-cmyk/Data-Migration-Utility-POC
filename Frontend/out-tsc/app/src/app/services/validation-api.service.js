import { __decorate } from "tslib";
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { timeout } from 'rxjs';
import { environment } from 'src/environments/environment';
let ValidationApiService = class ValidationApiService {
    constructor() {
        this.http = inject(HttpClient);
        // Point to FastAPI
        this.baseUrl = environment.apiUrl ? `${environment.apiUrl}/api/python` : 'http://localhost:8000/api/python';
    }
    getAuthHeaders() {
        const token = localStorage.getItem('supabase_token') || '';
        return new HttpHeaders({
            'Authorization': `Bearer ${token}`
        });
    }
    extractHeaders(formData) {
        return this.http.post(`${this.baseUrl}/extract-headers`, formData, {
            headers: this.getAuthHeaders()
        }).pipe(timeout(60000));
    }
    validateData(formData) {
        return this.http.post(`${this.baseUrl}/validate`, formData, {
            headers: this.getAuthHeaders()
        }).pipe(timeout(300000));
    }
    revalidateData(payload) {
        return this.http.post(`${this.baseUrl}/revalidate`, payload, {
            headers: this.getAuthHeaders()
        }).pipe(timeout(60000));
    }
};
ValidationApiService = __decorate([
    Injectable({
        providedIn: 'root'
    })
], ValidationApiService);
export { ValidationApiService };
//# sourceMappingURL=validation-api.service.js.map