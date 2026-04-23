import { Component, OnInit, inject, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook, write } from 'xlsx';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { ToastrService } from 'ngx-toastr';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import Swal from 'sweetalert2';

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
  
  // Updated Mapping Interface to handle Dropdown UI state
  mappings: { csvField: string, sfField: string, type: string, isDropdownOpen?: boolean, searchQuery?: string }[] = [];

  // Dropdown UI Trackers
  isObjectDropdownOpen = false;
  objectSearchQuery = '';

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

  // --- DROPDOWN UI LOGIC ---
  @HostListener('document:click', ['$event'])
  clickout(event: Event) {
      this.closeAllDropdowns();
  }

  closeAllDropdowns() {
    this.isObjectDropdownOpen = false;
    this.mappings.forEach(m => m.isDropdownOpen = false);
  }

  toggleObjectDropdown(event: Event) {
    event.stopPropagation();
    const wasOpen = this.isObjectDropdownOpen;
    this.closeAllDropdowns();
    this.isObjectDropdownOpen = !wasOpen;
    if (this.isObjectDropdownOpen) this.objectSearchQuery = '';
  }

  toggleDropdown(mapping: any, event: Event) {
    event.stopPropagation();
    const wasOpen = mapping.isDropdownOpen;
    this.closeAllDropdowns();
    mapping.isDropdownOpen = !wasOpen;
    if (mapping.isDropdownOpen) mapping.searchQuery = '';
  }

  getSfObjectLabel(objName: string): string {
    if (!objName) return '';
    const obj = this.sfObjects.find((o) => o.name === objName);
    return obj ? `${obj.label} (${obj.name})` : objName;
  }

  getFilteredSfObjects(): any[] {
    if (!this.objectSearchQuery) return this.sfObjects;
    const lowerQuery = this.objectSearchQuery.toLowerCase();
    return this.sfObjects.filter((o) => o.label?.toLowerCase().includes(lowerQuery) || o.name?.toLowerCase().includes(lowerQuery));
  }

  getSfFieldLabel(fieldName: string): string {
    if (!fieldName) return '';
    const field = this.sfFields.find((f) => f.name === fieldName);
    return field ? `${field.label} (${field.name})` : fieldName;
  }

  getFilteredSfFields(query?: string): any[] {
    if (!query) return this.sfFields;
    const lowerQuery = query.toLowerCase();
    return this.sfFields.filter((f) => f.label?.toLowerCase().includes(lowerQuery) || f.name?.toLowerCase().includes(lowerQuery));
  }

  selectTargetObject(objName: string) {
    this.selectedObject = objName;
    this.isObjectDropdownOpen = false;
    this.onObjectChange();
  }

  selectField(mapping: any, fieldName: string) {
    mapping.sfField = fieldName;
    mapping.isDropdownOpen = false;
    this.updateFieldType(mapping, fieldName);
  }

  // --- DATA LOADING LOGIC ---
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
      // Reset mappings if sheet changes
      this.mappings = this.csvHeaders.map(header => ({ csvField: header, sfField: '', type: 'string' }));
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
    if (!sfFieldName) {
      mapping.type = 'string';
      return;
    }
    const fieldMeta = this.sfFields.find(f => f.name === sfFieldName);
    if (fieldMeta) {
      mapping.type = fieldMeta.type;
    }
  }

  // --- AUTO-MAP LOGIC ---
  getConfirmedCount(): number {
    return this.mappings.filter((m) => m.sfField && m.sfField !== '').length;
  }

  private getSimilarity(s1: string, s2: string): number {
    let longer = s1; let shorter = s2;
    if (s1.length < s2.length) { longer = s2; shorter = s1; }
    const longerLength = longer.length;
    if (longerLength === 0) return 1.0;
    
    const costs = new Array();
    for (let i = 0; i <= longer.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= shorter.length; j++) {
        if (i == 0) costs[j] = j;
        else {
          if (j > 0) {
            let newValue = costs[j - 1];
            if (longer.charAt(i - 1) != shorter.charAt(j - 1))
              newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
            costs[j - 1] = lastValue;
            lastValue = newValue;
          }
        }
      }
      if (i > 0) costs[shorter.length] = lastValue;
    }
    return (longerLength - costs[shorter.length]) / parseFloat(longerLength.toString());
  }

  autoMapFields() {
    if (!this.sfFields || this.sfFields.length === 0) return;

    setTimeout(() => {
      let matchCount = 0;

      const normalizeString = (str: string) => {
        return String(str).toLowerCase().replace(/__c$/g, '').replace(/id$/g, '').replace(/[^a-z0-9]/g, '');
      };

      this.mappings.forEach(mapping => {
        if (!mapping.sfField) {
          const rawCsv = mapping.csvField;
          const normalCsv = normalizeString(rawCsv);

          let bestMatch = null;
          let highestScore = 0;

          for (const field of this.sfFields) {
            const normalName = normalizeString(field.name);
            const normalLabel = normalizeString(field.label);

            if (normalCsv === normalName || normalCsv === normalLabel) {
              bestMatch = field;
              highestScore = 1.0;
              break; 
            }

            const labelScore = this.getSimilarity(normalCsv, normalLabel);
            const nameScore = this.getSimilarity(normalCsv, normalName);
            const bestFieldScore = Math.max(labelScore, nameScore);

            if (bestFieldScore >= 0.8 && bestFieldScore > highestScore) {
              highestScore = bestFieldScore;
              bestMatch = field;
            }
          }

          if (bestMatch) {
            this.selectField(mapping, bestMatch.name);
            matchCount++;
          }
        }
      });

      if (matchCount > 0) {
        this.toastr.success(`Auto-mapped ${matchCount} fields successfully.`, 'Auto-Map Complete');
      } else {
        this.toastr.info(`Could not find any clear auto-map matches.`, 'No Matches');
      }

      this.cdr.detectChanges();
    });
  }

  clearAllMappings() {
    Swal.fire({
      title: 'Are you sure?',
      text: "You will lose all your currently mapped fields!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc3545',
      cancelButtonColor: '#6c757d',
      confirmButtonText: 'Yes, clear them!'
    }).then((result) => {
      if (result.isConfirmed) {
        this.mappings.forEach(m => {
          m.sfField = '';
        });
        this.toastr.info('All mappings have been reset.', 'Cleared');
        this.cdr.detectChanges();
      }
    });
  }

  // --- QUEUE LOGIC ---
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

    // Clean up mapping objects before passing them to the validation engine
    const cleanMappings = activeMappings.map(m => ({
      csvField: m.csvField,
      sfField: m.sfField,
      type: m.type
    }));

    this.validationQueue.push({
      sheetName: this.selectedSheetName,
      targetObject: this.selectedObject,
      rawData: [...this.rawData],
      csvHeaders: [...this.csvHeaders],
      mappings: cleanMappings,
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
    // ... KEEP YOUR EXACT EXISTING API CALL LOGIC ...
    if (this.validationQueue.length === 0) return;

    this.isValidating = true;
    this.aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
    
    let queueHasErrors = false;

    for (const job of this.validationQueue) {
      job.status = 'validating';
      this.cdr.detectChanges();

      const payload = {
        targetObject: job.targetObject,
        records: job.rawData,
        mappings: job.mappings,
        dedupeKey: job.dedupeKey,
        validCountries: { "united states": "US", "canada": "CA" }, 
        validStates: { "california": "CA", "new york": "NY" }
      };

      try {
        const res = await firstValueFrom(this.validationApi.validateData(payload));
        
        job.results = res;
        job.status = 'done';
        
        this.aggregateStats.total += res.stats.total || 0;
        this.aggregateStats.valid += res.stats.valid || 0;
        this.aggregateStats.invalid += res.stats.invalid || 0;
        this.aggregateStats.duplicates += res.stats.duplicates || 0;

      } catch (error: any) {
        job.status = 'error';
        queueHasErrors = true;

        if (error.name === 'TimeoutError') {
          this.toastr.error(`Batch for ${job.targetObject} timed out (exceeded 2 minutes). The file is too large.`, 'Timeout Warning');
        } else if (error.status === 504) {
          this.toastr.error(`The Data Engine timed out processing ${job.targetObject}. Try splitting the file.`, 'Server Timeout');
        } else if (error.error && error.error.message) {
          this.toastr.error(error.error.message, `Error: ${job.targetObject}`);
        } else {
          this.toastr.error(`An unexpected error occurred while validating ${job.targetObject}.`, 'Validation Failed');
        }
      }
      
      this.cdr.detectChanges();
    }

    this.isValidating = false;
    
    if (this.aggregateStats.total > 0 || !queueHasErrors) {
       this.currentStep = 2; // Trigger UI to move to Step 2
       if (queueHasErrors) {
         this.toastr.warning(`Queue finished, but some objects failed.`, 'Partial Completion');
       } else {
         this.toastr.success(`Queue Validation Complete!`, 'Done');
       }
    } else {
       this.toastr.error('Validation completely failed. Check the browser console.', 'Failed');
    }
    
    this.cdr.detectChanges();
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