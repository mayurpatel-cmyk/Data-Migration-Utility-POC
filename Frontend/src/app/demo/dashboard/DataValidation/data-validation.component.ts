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
  allHeadersMap: { [sheetName: string]: string[] } = {};

  // Current Form State
  selectedSheetName = '';
  csvHeaders: string[] = [];
  rawData: any[] = [];
  sfObjects: any[] = [];
  selectedObject = '';
  sfFields: any[] = [];
  dedupeKey = '';
  selectedDateFormat = ''; // <-- ADDED: For Date Format selection

  mappings: { csvField: string, sfField: string, type: string, isActive?: boolean, isDropdownOpen?: boolean, searchQuery?: string, dateFormat?: string, massUpdateValue?: string,
    isRequired?: boolean, picklistValues?: string[],
    parentObjectName?: string,
    relationalExtIdField?: string,
    isLoadingParentFields?: boolean,
    isParentDropdownOpen?: boolean,
    parentSearchQuery?: string,
    maxLength?: number
   }[] = [];

   // Dropdown UI Trackers
  isObjectDropdownOpen = false;
  objectSearchQuery = '';
  isLoadingObjects = false;

  parentObjectFieldsCache: { [objectName: string]: any[] } = {};

  // Queue State
  validationQueue: ValidationJob[] = [];
  isValidating = false;
  aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
  showingValidPreview: { [key: number]: boolean } = {};
  selectedErrorJobIndex: number = -1;
  errorCurrentPage: number = 1;
  errorPageSize: number = 50;

  toggleValidPreview(index: number) {
    this.showingValidPreview[index] = !this.showingValidPreview[index];
  }

  getPreviewRecords(records: any[]): any[] {
    return records ? records.slice(0, 50) : [];
  }

  ngOnInit() {
    this.migrationService.getAllObjects().subscribe(objs => {
      this.sfObjects = objs;
      this.cdr.detectChanges();
    });
  }

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

  get errorJobs() {
    return this.validationQueue
      .map((job, index) => ({ job, index }))
      .filter(item => item.job.results?.invalidRecords?.length > 0);
  }

  get paginatedErrorRecords() {
    if (this.selectedErrorJobIndex === -1 || !this.validationQueue[this.selectedErrorJobIndex]) return [];
    const records = this.validationQueue[this.selectedErrorJobIndex].results.invalidRecords;
    const start = (this.errorCurrentPage - 1) * this.errorPageSize;
    return records.slice(start, start + this.errorPageSize);
  }

  get errorTotalPages() {
    if (this.selectedErrorJobIndex === -1 || !this.validationQueue[this.selectedErrorJobIndex]) return 1;
    const total = this.validationQueue[this.selectedErrorJobIndex].results.invalidRecords.length;
    return Math.ceil(total / this.errorPageSize) || 1;
  }

  get currentErrorMaxBound() {
    if (this.selectedErrorJobIndex === -1) return 0;
    const total = this.validationQueue[this.selectedErrorJobIndex].results.invalidRecords.length;
    return Math.min(this.errorCurrentPage * this.errorPageSize, total);
  }

  nextErrorPage() {
    if (this.errorCurrentPage < this.errorTotalPages) this.errorCurrentPage++;
  }

  prevErrorPage() {
    if (this.errorCurrentPage > 1) this.errorCurrentPage--;
  }

  getSfFieldMeta(fieldName: string): any {
    if (!fieldName) return null;
    return this.sfFields.find((f) => f.name === fieldName);
  }

  getTotalRequiredFieldsCount(): number {
    if (!this.sfFields || this.sfFields.length === 0) return 0;
    const requiredFields = this.sfFields.filter(f => {
      return f.isRequired || (!f.nillable && f.createable && !f.defaultedOnCreate);
    });
    return requiredFields.length;
  }

  getMissingRequiredFields(): string[] {
    if (!this.sfFields || this.sfFields.length === 0) return [];
    const currentlyMapped = this.mappings
      .filter(m => m.isActive && m.sfField && m.sfField !== '')
      .map(m => m.sfField);
    const missingFields = this.sfFields.filter(f => {
      const isStrictlyRequired = f.isRequired || (!f.nillable && f.createable && !f.defaultedOnCreate);
      return isStrictlyRequired && !currentlyMapped.includes(f.name);
    });
    return missingFields.map(f => f.label || f.name);
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
    this.onSfFieldChange(mapping);
  }

  async onFileSelected(event: any) {
    const file = event.target.files[0];
    if (!file) return;

    // NEW: Take a snapshot of the user's current work before we overwrite the file
    const previousMappings = [...this.mappings];
    const previousSheet = this.selectedSheetName;

    this.selectedFile = file;
    this.availableSheets = [];
    this.csvHeaders = [];

    if ((file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) && file.size > 50 * 1024 * 1024) {
      this.toastr.warning(
        'Large Excel files process slowly. For best performance, consider converting this file to .CSV before uploading.',
        'Large File Warning',
        { timeOut: 8000 }
      );
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      this.toastr.info('Extracting file headers...', 'Reading File');
      const res: any = await firstValueFrom(this.validationApi.extractHeaders(formData));

      this.availableSheets = res.sheets;
      this.allHeadersMap = res.headersMap;

      if (this.availableSheets.length > 0) {
        // NEW: If they re-uploaded a file with the same sheet name, restore their work!
        if (previousSheet && this.availableSheets.includes(previousSheet)) {
          this.restoreSheetAndMappings(previousSheet, previousMappings);
          this.toastr.success('File updated. Previous mappings restored!', 'Smart Upload');
        } else {
          // Otherwise, treat it as a brand new upload
          this.onSheetSelect(this.availableSheets[0]);
        }
      }
    } catch (error) {
      this.toastr.error('Failed to read file headers. The file might be corrupted.');
    }
  }

  restoreSheetAndMappings(sheetName: string, previousMappings: any[]) {
    this.selectedSheetName = sheetName;
    this.csvHeaders = this.allHeadersMap[sheetName] || [];

    this.mappings = this.csvHeaders.map(header => {
      // Look to see if this column was mapped before the re-upload
      const existing = previousMappings.find(m => m.csvField === header);
      return existing
        ? { ...existing } // Keep everything (SF Field, Default Value, Skip rules, etc.)
        : {
            csvField: header,
            sfField: '',
            type: 'string',
            dateFormat: '',
            isActive: true,
            massUpdateValue: ''
          };
    });
    this.cdr.detectChanges();
  }

 onSheetSelect(sheetName: string) {
    this.selectedSheetName = sheetName;
    this.csvHeaders = this.allHeadersMap[sheetName] || [];
    this.mappings = this.csvHeaders.map(header => ({
      csvField: header,
      sfField: '',
      type: 'string',
      dateFormat: '',
      isActive: true,
      massUpdateValue: ''
    }));
    this.cdr.detectChanges();
  }

  onObjectChange() {
    if (!this.selectedObject) return;
    this.migrationService.getObjectFields(this.selectedObject).subscribe((res: any) => {
      this.sfFields = res.fields || res;
      this.mappings = this.csvHeaders.map(header => ({ csvField: header, sfField: '', type: 'string', dateFormat: '', isActive: true, massUpdateValue: '' }));
      this.cdr.detectChanges();
    });
  }

  applyMassUpdate(job: any, csvField: string, value: string | undefined) {
    if (value === undefined) value = '';
   // Check if there are actually records to update
    if (!job.results || !job.results.invalidRecords || job.results.invalidRecords.length === 0) return;

    let updatedCount = 0;

    // Loop through ALL error records, but ONLY apply the fix if that specific cell failed!
    job.results.invalidRecords.forEach((record: any) => {
      if (this.hasCellError(record, csvField)) {
        record.originalRow[csvField] = value;
        this.markAsEdited(record, csvField);
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      this.toastr.success(`Updated '${csvField}' across ${updatedCount} records. Correct data was left untouched!`, 'Smart Update Applied');
    } else {
      this.toastr.info(`No records had an error in '${csvField}', so nothing was changed.`, 'No Updates Needed');
    }

    this.cdr.detectChanges();
  }

  hasErrorsInColumn(job: any, csvField: string): boolean {
    if (!job || !job.results || !job.results.invalidRecords) return false;

    // Python returns errors formatted exactly like: "[Email: Invalid format.]"
    // We search the array to see if this column caused any of the failures.
    const searchStr = `[${csvField}:`;
    return job.results.invalidRecords.some((record: any) => record.errors.includes(searchStr));
  }

  // NEW: Checks if a SPECIFIC cell in a specific row has an error
  hasCellError(record: any, csvField: string): boolean {
    if (!record || !record.errors) return false;
    // By adding the bracket and colon, it forces an exact match!
    // E.g., it looks for "[Name:" instead of just "Name"
    const searchStr = `[${csvField}:`;
    return record.errors.includes(searchStr);
  }

  get allMappingsActive(): boolean {
    return this.mappings.length > 0 && this.mappings.every(m => m.isActive);
  }

  toggleMappingActive(mapping: any) {
    // If the user unchecks the box, clear the mapped field
    if (!mapping.isActive) {
      mapping.sfField = '';
      mapping.isDropdownOpen = false;
    }
  }

  toggleAllMappings(event: any) {
    const isChecked = event.target.checked;
    this.mappings.forEach(mapping => {
      mapping.isActive = isChecked;

      // If deselecting all, wipe out their field mappings for safety
      if (!isChecked) {
        mapping.sfField = '';
        mapping.isDropdownOpen = false;
      }
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
      const normalizeString = (str: string) => String(str).toLowerCase().replace(/__c$/g, '').replace(/id$/g, '').replace(/[^a-z0-9]/g, '');

      this.mappings.forEach(mapping => {
        if (mapping.isActive && !mapping.sfField) {
          const normalCsv = normalizeString(mapping.csvField);
          let bestMatch = null;
          let highestScore = 0;

          const currentlyMappedSfFields = this.mappings.filter(m => m.sfField).map(m => m.sfField);

          for (const field of this.sfFields) {
            if (currentlyMappedSfFields.includes(field.name)) continue;

            const normalName = normalizeString(field.name);
            const normalLabel = normalizeString(field.label);

            if (normalCsv === normalName || normalCsv === normalLabel) {
              bestMatch = field;
              highestScore = 1.0;
              break;
            }

            const bestFieldScore = Math.max(this.getSimilarity(normalCsv, normalLabel), this.getSimilarity(normalCsv, normalName));
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

  addToQueue() {
    const activeMappings = this.mappings.filter(m => m.isActive && m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field before queueing.', 'No Mappings');
      return;
    }

    const missingReqFields = this.getMissingRequiredFields();
    if (missingReqFields.length > 0) {
      Swal.fire({
        title: 'Missing Required Fields!',
        html: `Salesforce requires the following fields to create a <b>${this.selectedObject}</b>, but you haven't mapped them:<br><br>
               <div class="text-danger fw-bold text-start p-3 bg-light border rounded mt-2" style="max-height: 150px; overflow-y: auto;">
                 <i class="feather icon-alert-triangle me-1"></i> ${missingReqFields.join('<br><i class="feather icon-alert-triangle me-1"></i> ')}
               </div><br>
               <span class="small text-muted">Please map these columns or uncheck them to ignore.</span>`,
        icon: 'error',
        confirmButtonColor: '#0d6efd'
      });
      return;
    }

    const isDuplicate = this.validationQueue.some(job => job.targetObject === this.selectedObject && job.sheetName === this.selectedSheetName);
    if (isDuplicate) {
      this.toastr.error('This Sheet and Object combination is already in the queue.', 'Duplicate');
      return;
    }

    const cleanMappings = activeMappings.map(m => {
      const meta = this.getSfFieldMeta(m.sfField);
      const isReq = meta ? (meta.isRequired || (!meta.nillable && meta.createable && !meta.defaultedOnCreate)) : false;

      const picklistVals = meta && meta.picklistValues
        ? meta.picklistValues.filter((p: any) => p.active).map((p: any) => p.value.toLowerCase())
        : [];

        const fieldLength = meta ? meta.length : null;

      return {
        csvField: m.csvField,
        sfField: m.sfField,
        type: m.type,
        dateFormat: m.dateFormat || '',
        isActive: true,
        isRequired: isReq,
        picklistValues: picklistVals,
        skipValidation: m.type === 'reference',
        maxLength: fieldLength
      };
    });

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

    this.selectedObject = '';
    this.dedupeKey = '';
    // Reset mapping table for the next job
    this.mappings = this.csvHeaders.map(header => ({
      csvField: header, sfField: '', type: 'string',
      dateFormat: '', skipValidation: false, defaultValue: '', isActive: true, massUpdateValue: ''
    }));
    this.cdr.detectChanges();
  }

  editQueuedItem(index: number) {
    const itemToEdit = this.validationQueue.splice(index, 1)[0];
    this.selectedSheetName = itemToEdit.sheetName;
    this.selectedObject = itemToEdit.targetObject;
    this.rawData = [...itemToEdit.rawData];
    this.csvHeaders = [...itemToEdit.csvHeaders];
    this.dedupeKey = itemToEdit.dedupeKey || '';

    this.isLoadingObjects = true;
    this.migrationService.getObjectFields(this.selectedObject).subscribe({
      next: (res: any) => {
        this.sfFields = res.fields || res;

        this.mappings = this.csvHeaders.map(header => {
          const existing = itemToEdit.mappings.find((m: any) => m.csvField === header);
          return existing
            ? {
                ...existing,
                isDropdownOpen: false,
                searchQuery: '',
                isActive: true // Turn the checkbox back on
              }
            : {
                csvField: header,
                sfField: '',
                type: 'string',
                isDropdownOpen: false,
                searchQuery: '',
                dateFormat: '',
                massUpdateValue: '',
                isActive: false
              };
        });

        this.currentStep = 1;
        this.isLoadingObjects = false;
        this.cdr.detectChanges();
        window.scrollTo({ top: 0, behavior: 'smooth' });

        this.toastr.info(`You can now edit the mapping rules for ${this.selectedObject}.`, 'Edit Mode');
      },
      error: () => {
        this.toastr.error('Failed to load Salesforce fields for editing.', 'Error');
        this.isLoadingObjects = false;
      }
    });
  }

  removeFromQueue(index: number) {
    const removedItem = this.validationQueue.splice(index, 1)[0];
    this.toastr.info(`Removed ${removedItem.targetObject} from the queue.`, 'Item Removed');

    this.recalculateStats();

    if (this.currentStep === 2) {
      const nextErrorIdx = this.validationQueue.findIndex(j => j.results?.invalidRecords?.length > 0);
      this.selectedErrorJobIndex = nextErrorIdx !== -1 ? nextErrorIdx : -1;
      this.errorCurrentPage = 1;
    }

    if (this.validationQueue.length === 0) {
      this.currentStep = 1;
      this.aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
    }
  }

  async runValidationQueue() {
    if (this.validationQueue.length === 0) return;

    this.isValidating = true;
    let queueHasErrors = false;
    let processedAtLeastOne = false;

    for (const job of this.validationQueue) {
      if (job.status === 'done') continue;

      processedAtLeastOne = true;
      job.status = 'validating';
      this.cdr.detectChanges();

      const formData = new FormData();
      formData.append('file', this.selectedFile as Blob, this.selectedFile!.name);

      const config = {
        targetObject: job.targetObject,
        sheetName: job.sheetName,
        mappings: job.mappings,
        dedupeKey: job.dedupeKey
      };

      formData.append('config', JSON.stringify(config));

      try {
        const res: any = await firstValueFrom(this.validationApi.validateData(formData));
        job.results = res;
        job.status = 'done';

      } catch (error: any) {
        job.status = 'error';
        queueHasErrors = true;

        if (error.name === 'TimeoutError') {
          this.toastr.error(`Batch for ${job.targetObject} timed out. The file is too large.`, 'Timeout Warning');
        } else if (error.status === 504) {
          this.toastr.error(`The Data Engine timed out processing ${job.targetObject}. Try splitting the file.`, 'Server Timeout');
        } else if (error.error && error.error.message) {
          this.toastr.error(error.error.message, `Error: ${job.targetObject}`);
        } else {
          this.toastr.error(`An unexpected error occurred while validating ${job.targetObject}.`, 'Validation Failed');
        }
      }

      const firstErrorIdx = this.validationQueue.findIndex(j => j.results?.invalidRecords?.length > 0);
      this.selectedErrorJobIndex = firstErrorIdx !== -1 ? firstErrorIdx : -1;
      this.errorCurrentPage = 1;

      this.cdr.detectChanges();
    }

    this.isValidating = false;
    this.recalculateStats();

    if (this.aggregateStats.total > 0 || !queueHasErrors) {
      this.currentStep = 2;

      if (processedAtLeastOne) {
        if (queueHasErrors) {
          this.toastr.warning(`Queue finished, but some objects failed.`, 'Partial Completion');
        } else {
          this.toastr.success(`Queue Validation Complete!`, 'Done');
        }
      } else {
        this.toastr.info(`All items in the queue are already up-to-date.`, 'No New Validation Needed');
      }
    } else {
      this.toastr.error('Validation completely failed. Check the browser console.', 'Failed');
    }

    this.cdr.detectChanges();
  }

  downloadCleanData() {
    const newWorkbook = utils.book_new();
    let hasData = false;

    this.validationQueue.forEach((job) => {
      if (job.results?.validRecords?.length > 0) {
        const worksheet = utils.json_to_sheet(job.results.validRecords);
        const sheetTitle = (job.sheetName || `Clean_${job.targetObject}`).substring(0, 31);
        utils.book_append_sheet(newWorkbook, worksheet, sheetTitle);
        hasData = true;
      }
    });

    if (!hasData) {
      this.toastr.warning('No valid data available to download.', 'Empty');
      return;
    }

    const wbout = write(newWorkbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = `Cleaned_Batch_Data.xlsx`;
    link.click();
  }

  downloadDuplicates() {
    let allDuplicates: any[] = [];

    this.validationQueue.forEach(job => {
      if (job.results?.invalidRecords?.length > 0) {
        // Filter the invalid records to ONLY get the ones marked as Duplicates
        const duplicateRecords = job.results.invalidRecords
          .filter((ir: any) => ir.errors.includes('Duplicate Record'))
          .map((ir: any) => ({
            SourceSheet: job.sheetName,
            TargetObject: job.targetObject,
            RowNumber: ir.rowNumber,
            Errors: ir.errors,
            ...ir.originalRow
          }));
          
        allDuplicates = [...allDuplicates, ...duplicateRecords];
      }
    });

    if (allDuplicates.length === 0) {
      this.toastr.info('No duplicate records found to download.', 'Empty');
      return;
    }

    // Generate and download the CSV just like the Error Log!
    const worksheet = utils.json_to_sheet(allDuplicates);
    const csvOutput = utils.sheet_to_csv(worksheet);
    const blob = new Blob([csvOutput], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = `Validation_Duplicates.csv`;
    link.click();
  }

  recalculateStats() {
    let totalValid = 0;
    let totalInvalid = 0;
    let totalDuplicates = 0;

    this.validationQueue.forEach(job => {
      if (job.results) {
        totalValid += job.results.validRecords?.length || 0;
        totalInvalid += job.results.invalidRecords?.length || 0;
        totalDuplicates += job.results.stats?.duplicates || 0;
      }
    });

    this.aggregateStats = {
      total: totalValid + totalInvalid + totalDuplicates,
      valid: totalValid,
      invalid: totalInvalid,
      duplicates: totalDuplicates
    };
  }

  async revalidateJob(jobIndex: number) {
    const job = this.validationQueue[jobIndex];
    if (!job?.results?.invalidRecords?.length) return;

    this.isValidating = true;
    this.toastr.info(`Re-validating ${job.targetObject} records...`, 'Processing');
    this.cdr.detectChanges();

    // Deep copy the records so we don't accidentally mutate live data
    const recordsToTest = job.results.invalidRecords.map((ir: any) => {
      return { ...ir.originalRow, _originalRowNumber: ir.rowNumber };
    });
    const payload = {
      targetObject: job.targetObject,
      records: recordsToTest,
      mappings: job.mappings,
      dedupeKey: job.dedupeKey
    };

    try {
      const res: any = await firstValueFrom(this.validationApi.revalidateData(payload));

      const previousValid = job.results.validRecords || [];
      const newValid = res.validRecords || [];

      job.results.validRecords = [...previousValid, ...newValid]; // Combine them safely!
      job.results.invalidRecords = res.invalidRecords || [];

      this.recalculateStats();

      if (newValid.length > 0) {
        this.toastr.success(`Successfully fixed ${newValid.length} records!`, 'Errors Resolved');
      } else {
        this.toastr.warning('Records still contain errors. Please review them.', 'Still Invalid');
      }

    } catch (error: any) {
      console.error("Re-validation Error:", error);
      this.toastr.error(`Re-validation failed for ${job.targetObject}.`, 'Server Error');
    }

    this.isValidating = false;
    if (job.results.invalidRecords.length === 0) {
      const nextErrorIdx = this.validationQueue.findIndex(j => j.results?.invalidRecords?.length > 0);
      this.selectedErrorJobIndex = nextErrorIdx !== -1 ? nextErrorIdx : -1;
      this.errorCurrentPage = 1;
    }
    this.cdr.detectChanges();
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

  markAsEdited(record: any, fieldName: string) {
    if (!record._editedFields) {
      record._editedFields = {};
    }
    record._editedFields[fieldName] = true;
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

    this.router.navigateByUrl('/data-import').then(success => {
      if (!success) {
        console.error("Angular Router failed to navigate to /data-import");
        this.toastr.error('Navigation blocked by Angular Router.', 'Routing Error');
      }
    });
  }
  onSfFieldChange(mapping: any) {
  const fieldMeta = this.getSfFieldMeta(mapping.sfField);

  if (fieldMeta && fieldMeta.type === 'reference' && fieldMeta.referenceTo && fieldMeta.referenceTo.length > 0) {
    const parentObj = fieldMeta.referenceTo[0];
    mapping.parentObjectName = parentObj;

    if (!this.parentObjectFieldsCache[parentObj]) {
      mapping.isLoadingParentFields = true;
      this.cdr.detectChanges();

      this.migrationService.getObjectFields(parentObj).subscribe({
        next: (response: any) => {
          const fieldsArray = response.fields ? response.fields : response;
          this.parentObjectFieldsCache[parentObj] = fieldsArray.sort((a: any, b: any) => (a.label || '').localeCompare(b.label || ''));
          mapping.isLoadingParentFields = false;
          this.cdr.detectChanges();
        },
        error: () => {
          mapping.isLoadingParentFields = false;
          this.toastr.error(`Failed to load fields for parent object: ${parentObj}`);
          this.cdr.detectChanges();
        }
      });
    }
  } else {
    mapping.parentObjectName = undefined;
    mapping.relationalExtIdField = '';
  }
}

getParentFieldLabel(mapping: any, fieldName?: string): string {
  if (!fieldName) return '';
  if (fieldName === 'Id') return 'Id (Standard Salesforce ID)';
  if (!mapping.parentObjectName) return fieldName;
  const parentFields = this.parentObjectFieldsCache[mapping.parentObjectName] || [];
  const field = parentFields.find((f: any) => f.name === fieldName);
  return field ? `${field.label} (${field.name})` : fieldName;
}

getFilteredParentFields(mapping: any): any[] {
  if (!mapping.parentObjectName) return [];
  const parentFields = this.parentObjectFieldsCache[mapping.parentObjectName] || [];


  if (!mapping.parentSearchQuery) return parentFields;
  const query = mapping.parentSearchQuery.toLowerCase();
  return parentFields.filter(f => f.label.toLowerCase().includes(query) || f.name.toLowerCase().includes(query));
}

toggleParentDropdown(mapping: any, event: Event) {
  event.stopPropagation();
  const wasOpen = mapping.isParentDropdownOpen;
  this.closeAllDropdowns();
  mapping.isParentDropdownOpen = !wasOpen;
  if (mapping.isParentDropdownOpen) mapping.parentSearchQuery = '';
}

selectParentField(mapping: any, fieldName: string) {
  mapping.relationalExtIdField = fieldName;
  mapping.isParentDropdownOpen = false;
}
}
