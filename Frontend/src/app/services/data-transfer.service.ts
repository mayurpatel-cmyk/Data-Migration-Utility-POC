import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class DataTransferService {
  private validatedData: any[] | null = null;
  private fileName: string = '';
  private targetObject: string = ''; 

  // Data parameter is now an array of ValidationJobs
  setValidatedData(data: any[], fileName: string, targetObject: string) {
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
}