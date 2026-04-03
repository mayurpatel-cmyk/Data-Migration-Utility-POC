/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnInit, inject, ChangeDetectorRef, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook } from 'xlsx';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from 'src/app/theme/shared/components/breadcrumbs/breadcrumbs.component';
import { MigrationService } from 'src/app/services/migration.service';
import { ToastrService } from 'ngx-toastr';
import Swal from 'sweetalert2';

interface MappingMeta {
  csvField: string;
  sfField: string;
  type?: string;
  referenceTo?: string[];
  relationshipName?: string;
  relationalExtIdField?: string;
  parentObjectName?: string;
  isLoadingParentFields?: boolean;

  // UI State for the Main Field Dropdown
  isDropdownOpen?: boolean;
  searchQuery?: string;

  // NEW: UI State for the Parent Lookup Dropdown
  isParentDropdownOpen?: boolean;
  parentSearchQuery?: string;
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
  private eRef = inject(ElementRef);

  // --- MULTI-OBJECT QUEUE STATE ---
  migrationQueue: JobQueueItem[] = [];

  currentStep: number = 2;
  selectedCRM: string = 'Zoho';
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

  // --- PREVIEW STATE ---
  showPreview = false;
  previewData: any[] = [];
  previewHeaders: string[] = [];
  previewingItemIndex: number | null = null;
  previewItemData: any[] = [];
  previewItemHeaders: string[] = [];
  operationMode: string = 'insert';
  parentObjectFieldsCache: { [objectName: string]: any[] } = {};
  batchSize: number = 200;

  // --- STANDALONE DROPDOWN STATES ---
  isObjectDropdownOpen = false;
  objectSearchQuery = '';

  isUpsertKeyDropdownOpen = false;
  upsertKeySearchQuery = '';

 ngOnInit() {
    this.isLoadingObjects = true;
    this.migrationService.getAllObjects().subscribe({
      next: (objects) => {
        this.sfObjects = objects;
        
        // ADDED: cdr.detectChanges() to force the UI to remove the loading spinner instantly
        setTimeout(() => {
          this.isLoadingObjects = false;
          this.cdr.detectChanges(); 
        });
      },
      error: (err) => {
        // ADDED: cdr.detectChanges() here as well
        setTimeout(() => {
          this.isLoadingObjects = false;
          this.cdr.detectChanges(); 
        });
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
        this.csvHeaders = json[0].map((h: any) => (h ? String(h).trim() : '')).filter((h: string) => h.length > 0);
      } else {
        this.csvHeaders = [];
        this.toastr.warning(`Sheet "${sheetName}" appears to be empty.`, 'Empty Data');
      }
    }
  }

  // --- SEARCHABLE DROPDOWN HELPERS ---

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

  getFilteredUpsertKeys(): any[] {
    if (!this.upsertKeySearchQuery) return this.sfFields;
    const lowerQuery = this.upsertKeySearchQuery.toLowerCase();
    return this.sfFields.filter((f) => f.label?.toLowerCase().includes(lowerQuery) || f.name?.toLowerCase().includes(lowerQuery));
  }

  getSfFieldLabel(fieldName: string): string {
    if (!fieldName) return '';
    const field = this.getSfFieldMeta(fieldName);
    return field ? `${field.label} (${field.name})` : fieldName;
  }

  getFilteredSfFields(query?: string): any[] {
    if (!query) return this.sfFields;
    const lowerQuery = query.toLowerCase();
    return this.sfFields.filter((f) => f.label?.toLowerCase().includes(lowerQuery) || f.name?.toLowerCase().includes(lowerQuery));
  }

  // NEW: Helpers for Parent Ext ID Lookup
  getParentFieldLabel(mapping: MappingMeta, fieldName?: string): string {
    if (!fieldName) return '';
    if (fieldName === 'Id') return 'Id (Standard Salesforce ID)';
    if (!mapping.parentObjectName) return fieldName;
    const parentFields = this.parentObjectFieldsCache[mapping.parentObjectName] || [];
    const field = parentFields.find((f: any) => f.name === fieldName);
    return field ? `${field.label} (${field.name})` : fieldName;
  }

  getFilteredParentFields(mapping: MappingMeta): any[] {
    if (!mapping.parentObjectName) return [];
    const parentFields = this.parentObjectFieldsCache[mapping.parentObjectName] || [];
    if (!mapping.parentSearchQuery) return parentFields;
    const lowerQuery = mapping.parentSearchQuery.toLowerCase();
    return parentFields.filter((f: any) => f.label?.toLowerCase().includes(lowerQuery) || f.name?.toLowerCase().includes(lowerQuery));
  }

  // --- DROPDOWN TOGGLES & SELECTORS ---

  toggleObjectDropdown(event: Event) {
    event.stopPropagation();
    const wasOpen = this.isObjectDropdownOpen;
    this.closeAllDropdowns();
    this.isObjectDropdownOpen = !wasOpen;
    if (this.isObjectDropdownOpen) this.objectSearchQuery = '';
  }

  toggleUpsertKeyDropdown(event: Event) {
    event.stopPropagation();
    const wasOpen = this.isUpsertKeyDropdownOpen;
    this.closeAllDropdowns();
    this.isUpsertKeyDropdownOpen = !wasOpen;
    if (this.isUpsertKeyDropdownOpen) this.upsertKeySearchQuery = '';
  }

  toggleDropdown(mapping: MappingMeta, event: Event) {
    event.stopPropagation();
    const currentState = mapping.isDropdownOpen;
    this.closeAllDropdowns();
    mapping.isDropdownOpen = !currentState;
    if (mapping.isDropdownOpen) mapping.searchQuery = '';
  }

  toggleParentDropdown(mapping: MappingMeta, event: Event) {
    event.stopPropagation();
    const currentState = mapping.isParentDropdownOpen;
    this.closeAllDropdowns();
    mapping.isParentDropdownOpen = !currentState;
    if (mapping.isParentDropdownOpen) mapping.parentSearchQuery = '';
  }

  selectTargetObject(objName: string, stepContext: number) {
    this.selectedObject = objName;
    this.isObjectDropdownOpen = false;
    if (stepContext === 2) {
      this.onStep2ObjectChange(objName);
    } else {
      this.onObjectChangeInMapping(objName);
    }
  }

  selectUpsertKey(fieldName: string) {
    this.targetExtIdField = fieldName;
    this.isUpsertKeyDropdownOpen = false;
  }

  selectField(mapping: MappingMeta, fieldName: string) {
    mapping.sfField = fieldName;
    mapping.isDropdownOpen = false;
    this.onSfFieldChange(mapping);
  }

  selectParentField(mapping: MappingMeta, fieldName: string) {
    mapping.relationalExtIdField = fieldName;
    mapping.isParentDropdownOpen = false;
  }

  // Unified global close
  closeAllDropdowns() {
    this.mappings.forEach((m) => {
      m.isDropdownOpen = false;
      m.isParentDropdownOpen = false; // Close parent dropdowns too!
    });
    this.isObjectDropdownOpen = false;
    this.isUpsertKeyDropdownOpen = false;
  }

  @HostListener('document:click', ['$event'])
  clickout(event: Event) {
      this.closeAllDropdowns();
  }

  // --- CORE LOGIC METHODS ---

  getSfFieldMeta(fieldName: string): any {
    return this.sfFields.find((f) => f.name === fieldName);
  }

  getMissingRequiredFields(): string[] {
    if (!this.sfFields || this.sfFields.length === 0) return [];
    const requiredSfFields = this.sfFields.filter((f) => f.isRequired).map((f) => f.name);
    const currentlyMappedSfFields = this.mappings.map((m) => m.sfField).filter((val) => val !== '');
    return requiredSfFields.filter((reqField) => !currentlyMappedSfFields.includes(reqField));
  }

  onStep2ObjectChange(newObject: string) {
    if (!newObject) return;
    this.selectedObject = newObject;
    this.isLoadingFields = true;
    this.targetExtIdField = '';
    this.fetchObjectFields(newObject);
  }

  goToMapping() {
    if (this.csvHeaders.length === 0) return;
    if (this.operationMode === 'upsert' && !this.targetExtIdField) {
      this.toastr.warning('Please select a Primary Upsert Key before mapping.', 'Missing Configuration');
      return;
    }
    if (this.selectedFile && this.selectedObject) {
      this.currentStep = 3;
      this.autoNavigate();
      this.showPreview = false;
      this.previewingItemIndex = null;
      this.mappings = this.csvHeaders.map((header) => ({
        csvField: header,
        sfField: '',
        relationalExtIdField: ''
      }));
    }
  }

onSheetChangeInMapping(newSheet: string) {
    // ngModelChange fires during render. We MUST defer array recreation.
    setTimeout(() => {
      this.onSheetSelect(newSheet);
      this.mappings = this.csvHeaders.map(header => ({
        csvField: header,
        sfField: '',
        relationalExtIdField: ''
      }));
      this.showPreview = false;
      this.cdr.detectChanges();
    });
  }

  onObjectChangeInMapping(newObject: string) {
    if (!newObject) return;
    this.isLoadingFields = true;
    this.showPreview = false;
    this.targetExtIdField = '';
    this.fetchObjectFields(this.selectedObject);
  }

 autoMapFields() {
    if (!this.sfFields || this.sfFields.length === 0) {
      this.toastr.warning('Salesforce fields are not loaded yet. Please wait.', 'Not Ready');
      return;
    }

    // Wrap in setTimeout to defer the massive state update to the next tick
    setTimeout(() => {
      let matchCount = 0;

      const normalizeString = (str: string) => {
        return String(str).toLowerCase().replace(/__c$/g, '').replace(/id$/g, '').replace(/[^a-z0-9]/g, ''); 
      };

      const sfFieldDict: { [key: string]: any } = {};
      this.sfFields.forEach(field => {
        sfFieldDict[normalizeString(field.name)] = field;
        sfFieldDict[normalizeString(field.label)] = field; 
      });

      this.mappings.forEach(mapping => {
        if (!mapping.sfField) {
          const normalCsv = normalizeString(mapping.csvField);
          const matchedField = sfFieldDict[normalCsv];

          if (matchedField) {
            mapping.sfField = matchedField.name;
            matchCount++;
            this.onSfFieldChange(mapping);
          }
        }
      });

      if (matchCount > 0) {
        this.toastr.success(`Successfully auto-mapped ${matchCount} fields!`, 'Auto-Map Complete');
      } else {
        this.toastr.info('Could not find any automatic matches for the remaining fields.', 'Auto-Map');
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
      confirmButtonColor: '#dc3545', // Matches Bootstrap danger red
      cancelButtonColor: '#6c757d',  // Matches Bootstrap secondary grey
      confirmButtonText: 'Yes, clear them!'
    }).then((result) => {
      // This block only runs if they clicked "Yes"
      if (result.isConfirmed) {
        this.mappings.forEach(m => {
          m.sfField = '';
          m.relationalExtIdField = '';
          m.parentObjectName = undefined;
        });
        
        this.toastr.info('All mappings have been reset.', 'Cleared');
        this.cdr.detectChanges();
      }
    });
  }

 private fetchObjectFields(objectName: string, isEditMode: boolean = false) {
    this.migrationService.getObjectFields(objectName).subscribe({
      next: (response: any) => {
        // Move ALL state mutations inside setTimeout to prevent API race conditions
        setTimeout(() => {
          const fieldsArray = response.fields ? response.fields : response;
          // ADDED: Sort main object fields alphabetically
          this.sfFields = this.sortFieldsAlphabetically(fieldsArray);

          if (!isEditMode) {
            this.mappings.forEach(m => { m.sfField = ''; m.relationalExtIdField = ''; });
          } else {
            this.mappings.forEach(m => {
              if (m.parentObjectName && !this.parentObjectFieldsCache[m.parentObjectName]) {
                m.isLoadingParentFields = true;
                this.migrationService.getObjectFields(m.parentObjectName).subscribe({
                  next: (pRes: any) => {
                    setTimeout(() => {
                      const pFieldsArray = pRes.fields ? pRes.fields : pRes;
                      // ADDED: Sort parent object fields alphabetically
                      this.parentObjectFieldsCache[m.parentObjectName!] = this.sortFieldsAlphabetically(pFieldsArray);
                      m.isLoadingParentFields = false;
                      this.cdr.detectChanges();
                    });
                  }
                });
              }
            });
          }

          this.isLoadingFields = false;
          this.cdr.detectChanges();
        });
      },
      error: (err) => {
        setTimeout(() => {
          this.isLoadingFields = false;
          this.toastr.error('Failed to load object fields.', 'API Error');
          this.cdr.detectChanges();
        });
      }
    });
  }

  private sortFieldsAlphabetically(fields: any[]): any[] {
    if (!Array.isArray(fields)) return [];
    return fields.sort((a, b) => {
      // Sort by label, fallback to name if label doesn't exist
      const valA = (a.label || a.name || '').toLowerCase();
      const valB = (b.label || b.name || '').toLowerCase();
      return valA.localeCompare(valB);
    });
  }

  getConfirmedCount(mappings: any[]): number {
    return mappings.filter((m) => m.sfField && m.sfField !== '').length;
  }

 onSfFieldChange(mapping: MappingMeta) {
    const fieldMeta = this.getSfFieldMeta(mapping.sfField);

    if (fieldMeta && fieldMeta.type === 'reference' && fieldMeta.referenceTo && fieldMeta.referenceTo.length > 0) {
      const parentObj = fieldMeta.referenceTo[0];
      mapping.parentObjectName = parentObj;

      if (!this.parentObjectFieldsCache[parentObj]) {
        // Defer UI spinner activation
        setTimeout(() => { mapping.isLoadingParentFields = true; this.cdr.detectChanges(); });

        this.migrationService.getObjectFields(parentObj).subscribe({
          next: (response: any) => {
            setTimeout(() => {
              const fieldsArray = response.fields ? response.fields : response;
              // ADDED: Sort the relational parent fields alphabetically
              this.parentObjectFieldsCache[parentObj] = this.sortFieldsAlphabetically(fieldsArray);
              mapping.isLoadingParentFields = false;
              this.cdr.detectChanges();
            });
          },
          error: (err) => {
            setTimeout(() => {
              mapping.isLoadingParentFields = false;
              this.toastr.error(`Failed to load fields for parent object: ${parentObj}`, 'API Error');
              this.cdr.detectChanges();
            });
          }
        });
      }
    } else {
      mapping.parentObjectName = undefined;
      mapping.relationalExtIdField = '';
    }
  }

 queueAnotherObject() {
    // NEW: Check for duplicate target object in the queue
    const isDuplicate = this.migrationQueue.some((job) => job.targetObject === this.selectedObject);
    if (isDuplicate) {
      this.toastr.error(`The object "${this.selectedObject}" is already in the queue. Please edit the existing entry instead of adding it again.`, 'Duplicate Object');
      return;
    }

    if (this.operationMode === 'upsert' && this.getDynamicSequenceError()) {
      this.toastr.error(this.getDynamicSequenceError()!, 'Sequence Blocked');
      return;
    }
    const activeMappings = this.mappings.filter((m) => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field.', 'No Mappings');
      return;
    }
    const missingFields = this.getMissingRequiredFields();
    if (missingFields.length > 0) {
      this.toastr.error(`Missing required fields: ${missingFields.join(', ')}`, 'Validation Error');
      return;
    }
    if (this.operationMode === 'upsert' && !this.targetExtIdField) {
      this.toastr.error('Please select a Primary Upsert Key (External ID) for Upsert mode.', 'Missing Configuration');
      return;
    }
    const enhancedMappings = activeMappings.map((mapping) => {
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
      operationMode: this.operationMode,
      targetExtIdField: this.targetExtIdField
    });

    this.toastr.success(`${this.selectedObject} mapping saved to queue!`, 'Added to Queue');
    this.selectedObject = '';
    this.sfFields = [];
    this.mappings = this.csvHeaders.map((header) => ({ csvField: header, sfField: '', relationalExtIdField: '' }));
    this.confirmedMappings = [];
    this.targetExtIdField = '';
    this.operationMode = 'insert';
    this.showPreview = false;
    this.previewingItemIndex = null;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.cdr.detectChanges();
  }

  removeFromQueue(index: number) {
    if (this.previewingItemIndex === index) {
      this.previewingItemIndex = null;
    } else if (this.previewingItemIndex !== null && this.previewingItemIndex > index) {
      this.previewingItemIndex--;
    }
    const removed = this.migrationQueue.splice(index, 1)[0];
    this.toastr.info(`Removed ${removed.targetObject} from queue.`, 'Item Removed');
  }

  editQueuedItem(index: number) {
    if (this.selectedObject && this.mappings.some((m) => m.sfField !== '')) {
      this.queueAnotherObject();
      this.toastr.info(`Saved current mapping to queue before editing.`, 'Queue Updated');
    }
    const itemToEdit = this.migrationQueue.splice(index, 1)[0];
    this.previewingItemIndex = null;
    this.showPreview = false;
    this.selectedSheetName = itemToEdit.sheetName;
    this.selectedObject = itemToEdit.targetObject;
    this.csvHeaders = [...itemToEdit.csvHeaders];
    this.mappings = itemToEdit.mappings.map((m) => ({ ...m }));
    this.targetExtIdField = itemToEdit.targetExtIdField || '';
    this.operationMode = itemToEdit.operationMode || 'insert';
    this.currentStep = 3;
    this.isLoadingFields = true;
    this.cdr.detectChanges();
    this.fetchObjectFields(this.selectedObject, true);
  }

  previewCurrentMapping() {
    const activeMappings = this.mappings.filter((m) => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field to generate a preview.', 'No Mappings');
      return;
    }
    const worksheet = this.workbook!.Sheets[this.selectedSheetName];
    const rawData: any[] = utils.sheet_to_json(worksheet);
    this.previewHeaders = activeMappings.map((m) => m.sfField);
    const limit = Math.min(rawData.length, 5);
    const previewRows = [];
    for (let i = 0; i < limit; i++) {
      const rawRow = rawData[i];
      const sfRecord: any = {};
      activeMappings.forEach((mapping) => {
        sfRecord[mapping.sfField] = rawRow[mapping.csvField] !== undefined ? rawRow[mapping.csvField] : '';
      });
      previewRows.push(sfRecord);
    }
    this.previewData = previewRows;
    this.showPreview = true;
    this.toastr.info('Preview generated! Check below the mapping table.', 'Preview Ready');
  }

  previewQueuedItem(index: number) {
    if (this.previewingItemIndex === index) {
      this.previewingItemIndex = null;
      return;
    }
    const item = this.migrationQueue[index];
    const activeMappings = item.mappings.filter((m) => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('This queued item has no mapped fields to preview.', 'Empty Mapping');
      return;
    }
    const worksheet = this.workbook!.Sheets[item.sheetName];
    const rawData: any[] = utils.sheet_to_json(worksheet);
    this.previewItemHeaders = activeMappings.map((m) => m.sfField);
    const limit = Math.min(rawData.length, 5);
    const previewRows = [];
    for (let i = 0; i < limit; i++) {
      const rawRow = rawData[i];
      const sfRecord: any = {};
      activeMappings.forEach((mapping) => {
        sfRecord[mapping.sfField] = rawRow[mapping.csvField] !== undefined ? rawRow[mapping.csvField] : '';
      });
      previewRows.push(sfRecord);
    }
    this.previewItemData = previewRows;
    this.previewingItemIndex = index;
  }

goToReview() {
    this.confirmedMappings = this.mappings.filter((m) => m.sfField && m.sfField !== '');
    if (this.confirmedMappings.length === 0 && this.migrationQueue.length === 0) {
      this.toastr.warning('Please map at least one field.', 'Mapping Required');
      return;
    }
    if (this.confirmedMappings.length > 0) {
      const missingFields = this.getMissingRequiredFields();
      if (missingFields.length > 0) {
        this.toastr.error(`Missing required fields: ${missingFields.join(', ')}`, 'Validation Error');
        return; // Stops the process from moving forward
      }
    }
    const isUpsertMissingKey = this.operationMode === 'upsert' && !this.targetExtIdField;
    if (this.confirmedMappings.length > 0) {
      if (isUpsertMissingKey) {
        this.toastr.error('Please select a Primary Upsert Key before proceeding.', 'Missing Configuration');
        return;
      }

      // NEW: Check for duplicate target object in the queue
      const isDuplicate = this.migrationQueue.some((job) => job.targetObject === this.selectedObject);
      if (isDuplicate) {
        this.toastr.error(`The object "${this.selectedObject}" is already in the queue. Please edit the existing entry instead of adding it again.`, 'Duplicate Object');
        return;
      }

      const enhancedMappings = this.confirmedMappings.map((mapping) => {
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
        operationMode: this.operationMode
      });

      this.confirmedMappings = [];
      this.targetExtIdField = '';
    }

    this.currentStep = 4;
    this.autoNavigate();
    this.cdr.detectChanges();
  }

  getAllMigrationPlans() {
    return this.migrationQueue;
  }

  getActiveMappings(mappings: any[]) {
    return mappings.filter((m) => m.sfField && m.sfField !== '');
  }

  startMigration() {
    this.showPreview = false;
    this.previewingItemIndex = null;

    if (this.migrationQueue.length === 0) {
      this.toastr.warning('Please map at least one field before migrating.', 'No Mappings');
      return;
    }

    // 1. Calculate total records across all queued sheets for the alert
    let totalRows = 0;
    if (this.workbook) {
      this.migrationQueue.forEach(job => {
        const worksheet = this.workbook!.Sheets[job.sheetName];
        const rawData: any[] = utils.sheet_to_json(worksheet);
        totalRows += rawData.length;
      });
    }

    // 2. Calculate the estimated number of batches
    const estimatedBatches = Math.ceil(totalRows / this.batchSize);

    // 3. Show the SweetAlert Confirmation
    Swal.fire({
      title: '<strong>Ready for Data Migration ?</strong>',
      // We inject a mini Bootstrap dashboard right into the alert!
      html: `
        <div class="p-3 bg-light rounded-4 border border-secondary-subtle text-start mb-2 mt-3 shadow-inner">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <span class="text-muted fw-bold small text-uppercase tracking-wide">Total Records</span>
            <span class="fs-4 fw-bold text-dark">${totalRows.toLocaleString()}</span>
          </div>
          <div class="d-flex justify-content-between align-items-center mb-3">
            <span class="text-muted fw-bold small text-uppercase tracking-wide">Target Objects</span>
            <span class="fs-5 fw-bold text-primary bg-primary-subtle px-3 py-1 rounded-pill">${this.migrationQueue.length}</span>
          </div>
          <hr class="border-secondary-subtle my-2">
          <div class="d-flex justify-content-between align-items-center pt-2">
            <span class="text-muted fw-bold small text-uppercase tracking-wide">Execution Plan</span>
            <span class="badge bg-dark text-white px-3 py-2 rounded-pill shadow-sm">
              <i class="feather icon-layers me-1"></i> ~${estimatedBatches} Batches of ${this.batchSize.toLocaleString()}
            </span>
          </div>
        </div>
        <p class="text-muted small mt-3 mb-0"><i class="feather icon-shield text-success me-1"></i> Data will be safely chunked to prevent API timeouts.</p>
      `,
      icon: 'question',
      iconColor: '#0d6efd', // Bootstrap Primary Blue
      
      // Styling the Backdrop (Adds an Apple-style glass blur behind the alert)
      backdrop: `
        rgba(0, 0, 0, 0.4)
        backdrop-filter: blur(8px)
        left top
        no-repeat
      `,
      
      // Button Configuration
      showCancelButton: true,
      buttonsStyling: false, // Turn off default styling so we can use Bootstrap classes
      confirmButtonText: '<i class="feather icon-zap me-1"></i> Execute Migration',
      cancelButtonText: 'Review Again',
      
      // Injecting custom CSS classes into the SweetAlert components
      customClass: {
        popup: 'rounded-4 shadow-lg border-0',
        title: 'fs-3 fw-bold text-dark',
        confirmButton: 'btn btn-primary btn-lg rounded-pill shadow px-4 mx-2 fw-bold',
        cancelButton: 'btn btn-white btn-lg rounded-pill shadow-sm px-4 mx-2 border text-muted fw-bold'
      }
    }).then((result) => {
      
      // This block ONLY runs if they click "Yes"
      if (result.isConfirmed) {
        
        this.isMigrating = true;
        this.cdr.detectChanges();

        setTimeout(() => {
          try {
            const jobsPayload: any[] = [];

            for (const job of this.migrationQueue) {
              const worksheet = this.workbook!.Sheets[job.sheetName];
              const rawData: any[] = utils.sheet_to_json(worksheet);
              const relationalMapping = job.mappings.find((m) => m.type === 'reference' && m.relationalExtIdField !== '');

              if (relationalMapping) {
                const parentCsvColumn = relationalMapping.csvField;
                rawData.sort((a, b) => {
                  const valA = String(a[parentCsvColumn] || '');
                  const valB = String(b[parentCsvColumn] || '');
                  return valA.localeCompare(valB);
                });
              }

              jobsPayload.push({
                targetObject: job.targetObject,
                records: rawData,
                mappings: job.mappings,
                targetExtIdField: job.targetExtIdField,
                operationMode: job.operationMode,
                batchSize: this.batchSize // Passing the batch size to the backend
              });
            }

            this.migrationService.migrateData(jobsPayload).subscribe({
              next: (response) => {
                console.log('Migration response from server:', response);
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
    });
  }

  downloadSuccessLog() {
    const worksheet = utils.json_to_sheet(this.successfulRecords);
    const csvOutput = utils.sheet_to_csv(worksheet);
    this.saveAsCsv(csvOutput, 'success_log');
  }

  downloadErrorLog() {
    const report = this.failedRecords.map((f) => ({
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
      // Find all rows
      const rows = document.querySelectorAll('.row.mb-4');
      // Grab the last one (which is the newly opened step)
      const newStepElement = rows[rows.length - 1];
      
      if (newStepElement) {
        // Scroll so the TOP of the new step is at the top of the screen
        newStepElement.scrollIntoView({
          behavior: 'smooth',
          block: 'start' // Changed from 'nearest' to 'start'
        });
      }
    }, 150); // Slightly increased delay to ensure Angular has rendered the DOM
  }

  resetMigrationSession() {
    this.migrationQueue = [];
    this.selectedCRM = '';
    this.selectedFile = null;
    this.selectedObject = '';
    this.csvHeaders = [];

    this.workbook = null;
    this.availableSheets = [];
    this.selectedSheetName = '';

    this.sfFields = [];
    this.mappings = [];
    this.confirmedMappings = [];
    this.targetExtIdField = '';
    this.operationMode = 'insert';
    this.parentObjectFieldsCache = {};

    this.migrationSummary = null;
    this.failedRecords = [];
    this.successfulRecords = [];
    this.showPreview = false;
    this.previewData = [];
    this.previewHeaders = [];
    this.previewingItemIndex = null;

    this.currentStep = 2;
    this.selectedCRM = 'Zoho';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.cdr.detectChanges();
  }

  getDynamicSequenceError(): string | null {
    if (this.operationMode !== 'upsert' || !this.selectedObject) return null;

    const activeLookupMappings = this.mappings.filter((m) => {
      const meta = this.getSfFieldMeta(m.sfField);
      return m.sfField && meta?.type === 'reference';
    });

    for (const mapping of activeLookupMappings) {
      const meta = this.getSfFieldMeta(mapping.sfField);
      const parentObjects: string[] = meta.referenceTo || [];
      const externalParents = parentObjects.filter((p) => p !== this.selectedObject);

      if (externalParents.length > 0) {
        const isParentQueued = externalParents.some((parentName) => this.migrationQueue.some((q) => q.targetObject === parentName));

        if (!isParentQueued) {
          const parentName = externalParents[0];
          return `Upsert Blocked: The field "${meta.label}" requires the "${parentName}" sheet to be migrated first. Please go back and queue the "${parentName}" sheet.`;
        }
      }
    }
    return null;
  }

  hasOrderingIssue(): boolean {
    let issueFound = false;
    this.migrationQueue.forEach((job, index) => {
      job.mappings.forEach((m) => {
        if (m.relationalExtIdField && m.parentObjectName) {
          const parentIndex = this.migrationQueue.findIndex((q) => q.targetObject === m.parentObjectName);
          if (parentIndex !== -1 && parentIndex > index) {
            issueFound = true;
          }
        }
      });
    });
    return issueFound;
  }

  overrideGoToReview() {
    if (this.operationMode === 'upsert') {
      if (this.getDynamicSequenceError()) {
        this.toastr.error('Please resolve sequence errors before proceeding.', 'Logic Error');
        return;
      }
      if (this.hasOrderingIssue()) {
        this.toastr.error('Please reorder the queue: Parents (like Accounts) must be above Children.', 'Sequence Error');
        return;
      }
    }
    this.goToReview();
  }
}
