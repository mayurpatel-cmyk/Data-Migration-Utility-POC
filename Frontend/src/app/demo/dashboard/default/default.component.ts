/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook } from 'xlsx';
import { CardComponent } from "src/app/theme/shared/components/card/card.component";
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { MigrationService } from 'src/app/services/migration.service';
import { ToastrService } from 'ngx-toastr';

interface MappingMeta {
  csvField: string;
  sfField: string;
  type?: string;
  referenceTo?: string[];
  relationshipName?: string;
  relationalExtIdField?: string; 
}

interface JobQueueItem {
  sheetName: string;
  targetObject: string;
  csvHeaders: string[];
  mappings: MappingMeta[];
  targetExtIdField: string;
  operationMode: string;
}

@Component({
  selector: 'app-default',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent],
  templateUrl: './default.component.html',
  styleUrls: ['./default.component.scss']
})
export class DefaultComponent implements OnInit {
  private migrationService = inject(MigrationService);
  private cdr = inject(ChangeDetectorRef);
  private toastr = inject(ToastrService);

  migrationQueue: JobQueueItem[] = [];
  currentStep: number = 1;
  selectedCRM: string = '';
  selectedFile: File | null = null;
  selectedObject: string = '';
  csvHeaders: string[] = [];
  sfObjects: any[] = [];
  isLoadingObjects = false;

  workbook: WorkBook | null = null;
  availableSheets: string[] = [];
  selectedSheetName: string = '';

  sfFields: any[] = [];
  mappings: MappingMeta[] = [];
  confirmedMappings: MappingMeta[] = [];
  targetExtIdField: string = ''; 

  isLoadingFields = false;
  isMigrating = false;
  migrationSummary: any = null;
  failedRecords: any[] = []; 
  successfulRecords: any[] = []; 

  showPreview = false;
  previewData: any[] = [];
  previewHeaders: string[] = [];
  previewingItemIndex: number | null = null;
  previewItemData: any[] = [];
  previewItemHeaders: string[] = [];
  operationMode: string = 'insert';

  ngOnInit() {
    this.isLoadingObjects = true;
    this.migrationService.getAllObjects().subscribe({
      next: (objects) => {
        this.sfObjects = objects;
        setTimeout(() => this.isLoadingObjects = false);
      },
      error: (err) => {
        setTimeout(() => this.isLoadingObjects = false);
        this.toastr.error('Could not load Salesforce objects.', 'Connection Error');
      }
    });
  }

  onCRMSelect(crm: string) {
    this.selectedCRM = crm;
    setTimeout(() => {
      this.currentStep = 2;
      this.autoNavigate();
      this.cdr.detectChanges();
    }, 300);
  }

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.selectedFile = file;
      const reader = new FileReader();
      reader.onload = (e: any) => {
        const data = new Uint8Array(e.target.result);
        this.workbook = read(data, { type: 'array' });
        this.availableSheets = this.workbook.SheetNames;
        if (this.availableSheets.length === 1) {
          this.onSheetSelect(this.availableSheets[0]);
        } else {
          this.selectedSheetName = '';
          this.csvHeaders = [];
        }
        setTimeout(() => this.cdr.detectChanges());
      };
      reader.readAsArrayBuffer(file);
    } else {
      this.selectedFile = null;
      this.csvHeaders = [];
      this.availableSheets = [];
    }
  }

  onSheetSelect(sheetName: string) {
    this.selectedSheetName = sheetName;
    if (this.workbook) {
      const worksheet = this.workbook.Sheets[sheetName];
      const json: any[][] = utils.sheet_to_json(worksheet, { header: 1 });
      if (json.length > 0) {
        this.csvHeaders = json[0]
          .map((h: any) => h ? String(h).trim() : '')
          .filter((h: string) => h.length > 0);
      } else {
        this.csvHeaders = [];
        this.toastr.warning(`Sheet "${sheetName}" appears to be empty.`, 'Empty Data');
      }
    }
  }

  getSfFieldMeta(fieldName: string): any {
    return this.sfFields.find(f => f.name === fieldName);
  }

  getMissingRequiredFields(): string[] {
    if (!this.sfFields || this.sfFields.length === 0) return [];
    const requiredSfFields = this.sfFields.filter(f => f.isRequired).map(f => f.name);
    const currentlyMappedSfFields = this.mappings.map(m => m.sfField).filter(val => val !== '');
    return requiredSfFields.filter(reqField => !currentlyMappedSfFields.includes(reqField));
  }

  goToMapping() {
    if (this.csvHeaders.length === 0) return;
    if (this.selectedFile && this.selectedObject) {
      this.currentStep = 3;
      this.autoNavigate();
      this.isLoadingFields = true;
      this.showPreview = false;
      this.previewingItemIndex = null;
      this.targetExtIdField = ''; 

      this.mappings = this.csvHeaders.map(header => ({
        csvField: header,
        sfField: '',
        relationalExtIdField: ''
      }));

      this.fetchObjectFields(this.selectedObject);
    }
  }

  onSheetChangeInMapping(newSheet: string) {
    this.onSheetSelect(newSheet);
    this.mappings = this.csvHeaders.map(header => ({
      csvField: header,
      sfField: '',
      relationalExtIdField: ''
    }));
    this.showPreview = false;
  }

  onObjectChangeInMapping(newObject: string) {
    if (!newObject) return;
    this.isLoadingFields = true;
    this.showPreview = false;
    this.targetExtIdField = '';
    this.fetchObjectFields(this.selectedObject);
  }

  private fetchObjectFields(objectName: string) {
    this.migrationService.getObjectFields(objectName).subscribe({
      next: (response: any) => {
        const fieldsArray = response.fields ? response.fields : response;
        this.sfFields = Array.isArray(fieldsArray) ? fieldsArray : [];
        this.mappings.forEach(m => { m.sfField = ''; m.relationalExtIdField = ''; });
        setTimeout(() => {
          this.isLoadingFields = false;
          this.cdr.detectChanges();
        });
      },
      error: (err) => {
        this.isLoadingFields = false;
        this.toastr.error('Failed to load object fields.', 'API Error');
      }
    });
  }

  getConfirmedCount(mappings: any[]): number {
    return mappings.filter(m => m.sfField && m.sfField !== '').length;
  }

 queueAnotherObject() {
    const activeMappings = this.mappings.filter(m => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field.', 'No Mappings');
      return;
    }

    const missingFields = this.getMissingRequiredFields();
    if (missingFields.length > 0) {
      this.toastr.error(`Missing required fields: ${missingFields.join(', ')}`, 'Validation Error');
      return;
    }

    // --- NEW LOGIC: Only enforce External ID if Upsert is selected ---
    if (this.operationMode === 'upsert' && !this.targetExtIdField) {
      this.toastr.error('Please select a Primary Upsert Key (External ID).', 'Missing Configuration');
      return;
    }

    const enhancedMappings = activeMappings.map(mapping => {
      const fieldMeta = this.getSfFieldMeta(mapping.sfField);
      return {
        ...mapping,
        type: fieldMeta?.type,
        referenceTo: fieldMeta?.referenceTo,
        relationshipName: fieldMeta?.relationshipName 
      };
    });

    this.migrationQueue.push({
      sheetName: this.selectedSheetName,
      targetObject: this.selectedObject,
      csvHeaders: [...this.csvHeaders],
      mappings: enhancedMappings,
      operationMode: this.operationMode, // <-- Save the mode to the queue
      targetExtIdField: this.targetExtIdField 
    });

    this.toastr.success(`${this.selectedObject} mapping saved to queue!`, 'Added to Queue');

    // Reset for next object
    this.selectedObject = '';
    this.sfFields = [];
    this.mappings = this.csvHeaders.map(header => ({ csvField: header, sfField: '', relationalExtIdField: '' }));
    this.confirmedMappings = [];
    this.targetExtIdField = '';
    this.operationMode = 'insert'; // Reset to default
    this.showPreview = false;
    this.previewingItemIndex = null;
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.cdr.detectChanges();
  }

  removeFromQueue(index: number) {
    if (this.previewingItemIndex === index) this.previewingItemIndex = null;
    else if (this.previewingItemIndex !== null && this.previewingItemIndex > index) this.previewingItemIndex--;
    const removed = this.migrationQueue.splice(index, 1)[0];
    this.toastr.info(`Removed ${removed.targetObject} from queue.`, 'Item Removed');
  }

  editQueuedItem(index: number) {
    if (this.selectedObject && this.mappings.some(m => m.sfField !== '')) {
      this.queueAnotherObject(); 
    }

    const itemToEdit = this.migrationQueue.splice(index, 1)[0];
    this.previewingItemIndex = null;
    this.showPreview = false;

    this.selectedSheetName = itemToEdit.sheetName;
    this.selectedObject = itemToEdit.targetObject;
    this.csvHeaders = [...itemToEdit.csvHeaders];
    this.mappings = [...itemToEdit.mappings];
    this.targetExtIdField = itemToEdit.targetExtIdField || '';
    
    this.currentStep = 3;
    this.isLoadingFields = true;
    this.cdr.detectChanges();
    this.fetchObjectFields(this.selectedObject);
  }

  previewCurrentMapping() {
    const activeMappings = this.mappings.filter(m => m.sfField !== '');
    if (activeMappings.length === 0) return;

    const worksheet = this.workbook!.Sheets[this.selectedSheetName];
    const rawData: any[] = utils.sheet_to_json(worksheet);

    this.previewHeaders = activeMappings.map(m => m.sfField);
    const limit = Math.min(rawData.length, 5);
    const previewRows = [];

    for (let i = 0; i < limit; i++) {
      const rawRow = rawData[i];
      const sfRecord: any = {};
      activeMappings.forEach(mapping => {
        sfRecord[mapping.sfField] = rawRow[mapping.csvField] !== undefined ? rawRow[mapping.csvField] : '';
      });
      previewRows.push(sfRecord);
    }
    this.previewData = previewRows;
    this.showPreview = true;
  }

  previewQueuedItem(index: number) {
    if (this.previewingItemIndex === index) {
      this.previewingItemIndex = null; 
      return;
    }
    const item = this.migrationQueue[index];
    const activeMappings = item.mappings.filter(m => m.sfField !== '');
    if (activeMappings.length === 0) return;

    const worksheet = this.workbook!.Sheets[item.sheetName];
    const rawData: any[] = utils.sheet_to_json(worksheet);

    this.previewItemHeaders = activeMappings.map(m => m.sfField);
    const limit = Math.min(rawData.length, 5);
    const previewRows = [];

    for (let i = 0; i < limit; i++) {
      const rawRow = rawData[i];
      const sfRecord: any = {};
      activeMappings.forEach(mapping => {
        sfRecord[mapping.sfField] = rawRow[mapping.csvField] !== undefined ? rawRow[mapping.csvField] : '';
      });
      previewRows.push(sfRecord);
    }
    this.previewItemData = previewRows;
    this.previewingItemIndex = index;
  }

  goToReview() {
    this.confirmedMappings = this.mappings.filter(m => m.sfField && m.sfField !== '');
    
    if (this.confirmedMappings.length === 0 && this.migrationQueue.length === 0) {
      this.toastr.warning('Please map at least one field or ensure you have queued objects.', 'Mapping Required');
      return;
    }
    
    if (this.confirmedMappings.length > 0 && this.targetExtIdField) {
        const enhancedMappings = this.confirmedMappings.map(mapping => {
            const fieldMeta = this.getSfFieldMeta(mapping.sfField);
            return {
                ...mapping,
                type: fieldMeta?.type,
                referenceTo: fieldMeta?.referenceTo,
                relationshipName: fieldMeta?.relationshipName
            };
        });

        this.migrationQueue.push({
            sheetName: this.selectedSheetName,
            targetObject: this.selectedObject,
            csvHeaders: [...this.csvHeaders],
            mappings: enhancedMappings,
            targetExtIdField: this.targetExtIdField,
            operationMode: this.operationMode,
        });
        
        this.confirmedMappings = [];
        this.targetExtIdField = '';
    } else if (this.confirmedMappings.length > 0 && !this.targetExtIdField) {
        this.toastr.error('Please select a Primary Upsert Key before proceeding.', 'Missing Configuration');
        return;
    }

    this.currentStep = 4;
    this.autoNavigate();
    this.cdr.detectChanges();
  }

  getAllMigrationPlans() {
    return this.migrationQueue;
  }

  getActiveMappings(mappings: any[]) {
    return mappings.filter(m => m.sfField && m.sfField !== '');
  }

  startMigration() {
    this.showPreview = false; 
    this.previewingItemIndex = null;

    if (this.migrationQueue.length === 0) {
      this.toastr.warning('Please map at least one field before migrating.', 'No Mappings');
      return;
    }

    this.isMigrating = true;
    this.cdr.detectChanges(); 

    setTimeout(() => {
      try {
        const jobsPayload: any[] = [];

        for (const job of this.migrationQueue) {
          const worksheet = this.workbook!.Sheets[job.sheetName];
          const rawData: any[] = utils.sheet_to_json(worksheet); 
          
          // --- NEW: PRE-SORT BY PARENT EXT ID TO PREVENT SALESFORCE ROW LOCKS ---
          // Find if this specific job maps to a Parent Object using an External ID
          const relationalMapping = job.mappings.find(m => m.type === 'reference' && m.relationalExtIdField !== '');
          
          if (relationalMapping) {
            const parentCsvColumn = relationalMapping.csvField;
            
            // Sort alphabetically by the parent's external ID so chunks in SF go to the same parent
            rawData.sort((a, b) => {
              const valA = String(a[parentCsvColumn] || '');
              const valB = String(b[parentCsvColumn] || '');
              return valA.localeCompare(valB);
            });
          }
          // ---------------------------------------------------------------------
          
          jobsPayload.push({
            targetObject: job.targetObject,
            records: rawData, 
            mappings: job.mappings,
            targetExtIdField: job.targetExtIdField,
            operationMode: job.operationMode,
          });
        }

        this.migrationService.migrateData(jobsPayload).subscribe({
          next: (response) => {
            this.isMigrating = false;
            const successCount = response.stats?.success || 0;
            const failedCount = response.stats?.failed || 0;
            this.migrationSummary = response.stats;
            this.failedRecords = response.failures || [];
            this.successfulRecords = response.successfulRecords || [];
            
            const msg = `Successfully processed ${successCount} records. Failed: ${failedCount}`;

            if (successCount > 0 && failedCount === 0) {
              this.toastr.success(msg, 'Migration Complete!');
            } else if (successCount > 0 && failedCount > 0) {
              this.toastr.warning(msg, 'Partial Migration');
            } else {
              this.toastr.error(`${msg}. Please review the error log.`, 'Migration Failed');
            }

            this.currentStep = 5;
            this.autoNavigate();
            this.cdr.detectChanges();
          },
          error: (err) => {
            this.isMigrating = false;
            const errMsg = err.error?.message || 'Check console for details';
            this.toastr.error(errMsg, 'Server Error');
            this.cdr.detectChanges();
          }
        });

      } catch (error) {
        this.isMigrating = false;
        this.toastr.error('Failed to read data from the file.', 'Parsing Error');
        this.cdr.detectChanges();
      }
    }, 10); 
  }

  downloadSuccessLog() {
    const worksheet = utils.json_to_sheet(this.successfulRecords);
    const csvOutput = utils.sheet_to_csv(worksheet);
    this.saveAsCsv(csvOutput, 'success_log');
  }

  downloadErrorLog() {
    const report = this.failedRecords.map(f => ({
      Error: f.error,
      ...f.record
    }));
    const worksheet = utils.json_to_sheet(report);
    const csvOutput = utils.sheet_to_csv(worksheet);
    this.saveAsCsv(csvOutput, 'error_log');
  }

  private saveAsCsv(buffer: string, fileName: string) {
    const data = new Blob([buffer], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(data);
    link.download = `${fileName}_${new Date().getTime()}.csv`;
    link.click();
  }

  private autoNavigate() {
    setTimeout(() => {
      const element = document.querySelector('.row.mb-4:last-of-type');
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
      }
    }, 100);
  }
}