import { __decorate } from "tslib";
import { Injectable } from '@angular/core';
let DataTransferService = class DataTransferService {
    constructor() {
        this.validatedData = null;
        this.fileName = '';
        this.targetObject = '';
    }
    // Data parameter is now an array of ValidationJobs
    setValidatedData(data, fileName, targetObject) {
        this.validatedData = data;
        this.fileName = fileName;
        this.targetObject = targetObject;
    }
    getValidatedData() {
        const data = {
            data: this.validatedData, // Array of ValidationJobs
            fileName: this.fileName,
            targetObject: this.targetObject
        };
        this.clearData();
        return data;
    }
    clearData() {
        this.validatedData = null;
        this.fileName = '';
        this.targetObject = '';
    }
};
DataTransferService = __decorate([
    Injectable({ providedIn: 'root' })
], DataTransferService);
export { DataTransferService };
//# sourceMappingURL=data-transfer.service.js.map