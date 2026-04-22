import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook, write } from 'xlsx';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { ToastrService } from 'ngx-toastr';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ValidationApiService } from 'src/app/services/validation-api.service';
import { MigrationService } from 'src/app/services/migration.service';
import { DataTransferService } from 'src/app/services/data-transfer.service';

interface ValidationJob {
  sheetName: string;
  targetObject: string;
  rawData: any[];
  csvHeaders: string[];
  mappings: any[];
  dedupeKey: string;
  results?: any; 
  status?: 'pending' | 'validating' | 'done' | 'error';
}

@Component({
  selector: 'app-data-validation',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent],
  templateUrl: './data-validation.component.html'
})
export class DataValidationComponent implements OnInit {
  private toastr = inject(ToastrService);
  private router = inject(Router);
  private validationApi = inject(ValidationApiService);
  private migrationService = inject(MigrationService);
  private dataTransfer = inject(DataTransferService);
  private cdr = inject(ChangeDetectorRef); 

  currentStep = 1;
  selectedFile: File | null = null;
  workbook: WorkBook | null = null;
  availableSheets: string[] = [];
  
  // Current Form State
  selectedSheetName = '';
  csvHeaders: string[] = [];
  rawData: any[] = [];
  sfObjects: any[] = [];
  selectedObject = '';
  sfFields: any[] = [];
  dedupeKey = '';
  mappings: { csvField: string, sfField: string, type: string }[] = [];

  // Queue State
  validationQueue: ValidationJob[] = [];
  isValidating = false;
  aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };

  ngOnInit() {
    this.migrationService.getAllObjects().subscribe(objs => {
      this.sfObjects = objs;
      this.cdr.detectChanges(); 
    });
  }

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    this.selectedFile = file;
    
    const reader = new FileReader();
    reader.onload = (e: any) => {
      const data = new Uint8Array(e.target.result);
      this.workbook = read(data, { type: 'array' });
      this.availableSheets = this.workbook.SheetNames;
      if (this.availableSheets.length > 0) {
        this.onSheetSelect(this.availableSheets[0]);
      }
      this.cdr.detectChanges(); 
    };
    reader.readAsArrayBuffer(file);
  }

  onSheetSelect(sheetName: string) {
    this.selectedSheetName = sheetName;
    const worksheet = this.workbook!.Sheets[sheetName];
    this.rawData = utils.sheet_to_json(worksheet);
    if (this.rawData.length > 0) {
      this.csvHeaders = Object.keys(this.rawData[0]);
    }
    this.cdr.detectChanges(); 
  }

  onObjectChange() {
    if (!this.selectedObject) return;
    this.migrationService.getObjectFields(this.selectedObject).subscribe((res: any) => {
      this.sfFields = res.fields || res;
      this.mappings = this.csvHeaders.map(header => ({ csvField: header, sfField: '', type: 'string' }));
      this.cdr.detectChanges(); 
    });
  }

  updateFieldType(mapping: any, sfFieldName: string) {
    const fieldMeta = this.sfFields.find(f => f.name === sfFieldName);
    if (fieldMeta) {
      mapping.sfField = fieldMeta.name;
      mapping.type = fieldMeta.type;
    }
  }

  addToQueue() {
    const activeMappings = this.mappings.filter(m => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field before queueing.', 'No Mappings');
      return;
    }

    const isDuplicate = this.validationQueue.some(job => job.targetObject === this.selectedObject && job.sheetName === this.selectedSheetName);
    if (isDuplicate) {
      this.toastr.error('This Sheet and Object combination is already in the queue.', 'Duplicate');
      return;
    }

    this.validationQueue.push({
      sheetName: this.selectedSheetName,
      targetObject: this.selectedObject,
      rawData: [...this.rawData],
      csvHeaders: [...this.csvHeaders],
      mappings: activeMappings,
      dedupeKey: this.dedupeKey,
      status: 'pending'
    });

    this.toastr.success(`${this.selectedObject} added to validation queue!`, 'Queued');
    
    // Reset Form for next selection
    this.selectedObject = '';
    this.dedupeKey = '';
    this.mappings = this.csvHeaders.map(header => ({ csvField: header, sfField: '', type: 'string' }));
    this.cdr.detectChanges();
  }

  removeFromQueue(index: number) {
    this.validationQueue.splice(index, 1);
  }

  async runValidationQueue() {
    if (this.validationQueue.length === 0) return;

    this.isValidating = true;
    this.aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
    
    try {
      for (const job of this.validationQueue) {
        job.status = 'validating';
        this.cdr.detectChanges();

        const payload = {
          records: job.rawData,
          mappings: job.mappings,
          dedupeKey: job.dedupeKey
        };

        const res = await firstValueFrom(this.validationApi.validateData(payload));
        
        job.results = res;
        job.status = 'done';
        
        this.aggregateStats.total += res.stats.total || 0;
        this.aggregateStats.valid += res.stats.valid || 0;
        this.aggregateStats.invalid += res.stats.invalid || 0;
        this.aggregateStats.duplicates += res.stats.duplicates || 0;
      }

      this.currentStep = 2;
      this.toastr.success(`Queue Validation Complete!`, 'Done');
    } catch (error) {
      this.toastr.error('A server error occurred during batch validation.', 'Error');
    } finally {
      this.isValidating = false;
      this.cdr.detectChanges();
    }
  }

  downloadCleanData() {
    const newWorkbook = utils.book_new();
    let hasData = false;

    this.validationQueue.forEach((job, index) => {
      if (job.results?.validRecords?.length > 0) {
        const worksheet = utils.json_to_sheet(job.results.validRecords);
        // Ensure sheet names are unique and within Excel's 31-char limit
        const sheetTitle = (job.sheetName || `Clean_${job.targetObject}`).substring(0, 31);
        utils.book_append_sheet(newWorkbook, worksheet, sheetTitle);
        hasData = true;
      }
    });

    if (!hasData) return;
    
    const wbout = write(newWorkbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = `Cleaned_Batch_Data.xlsx`;
    link.click();
  }

  downloadErrorLog() {
    let allErrors: any[] = [];

    this.validationQueue.forEach(job => {
      if (job.results?.invalidRecords?.length > 0) {
        const mappedErrors = job.results.invalidRecords.map((ir: any) => ({
          SourceSheet: job.sheetName,
          TargetObject: job.targetObject,
          RowNumber: ir.rowNumber,
          Errors: ir.errors,
          ...ir.originalRow
        }));
        allErrors = [...allErrors, ...mappedErrors];
      }
    });

    if (allErrors.length === 0) return;

    const worksheet = utils.json_to_sheet(allErrors);
    const csvOutput = utils.sheet_to_csv(worksheet);
    const blob = new Blob([csvOutput], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = `Validation_ErrorLog.csv`;
    link.click();
  }

routeToMigration() {
    const validJobs = this.validationQueue.filter(j => j.results && j.results.validRecords && j.results.validRecords.length > 0);
    
    if (validJobs.length === 0) {
      this.toastr.warning('No valid records to migrate! Please check the Error Logs.', 'Cannot Route');
      return;
    }
    
    this.dataTransfer.setValidatedData(
      validJobs, 
      `Cleaned_${this.selectedFile?.name || 'Batch.xlsx'}`,
      '' 
    );
    
    this.toastr.info('Routing queue to Migration engine...', 'Transferring');
    
    // Force absolute routing path
    this.router.navigateByUrl('/data-import').then(success => {
      if (!success) {
        console.error("Angular Router failed to navigate to /data-import");
        this.toastr.error('Navigation blocked by Angular Router.', 'Routing Error');
      }
    });
  }
}