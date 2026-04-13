/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnInit, inject, ChangeDetectorRef, HostListener, ElementRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook } from 'xlsx';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from 'src/app/theme/shared/components/breadcrumbs/breadcrumbs.component';
import { MigrationService } from 'src/app/services/migration.service';
import { ToastrService } from 'ngx-toastr';
import Swal from 'sweetalert2';
import { AuthService } from '../../Services/auth.service';
import { ActivatedRoute, Router } from '@angular/router';

interface MappingMeta {
  csvField: string;
  sfField: string;
  type?: string;
  referenceTo?: string[];
  relationshipName?: string;
  relationalExtIdField?: string;
  parentObjectName?: string;
  isLoadingParentFields?: boolean;

  isDropdownOpen?: boolean;
  searchQuery?: string;

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
  private route = inject(ActivatedRoute); // <--- Add this
  private router = inject(Router);
  private authService = inject(AuthService);

  migrationQueue: JobQueueItem[] = [];

  currentStep: number = 2;
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

  // Default to insert
  operationMode: string = 'insert';
  parentObjectFieldsCache: { [objectName: string]: any[] } = {};
  batchSize: number = 200;

  isObjectDropdownOpen = false;
  objectSearchQuery = '';

  isUpsertKeyDropdownOpen = false;
  upsertKeySearchQuery = '';
  displayName = signal('Salesforce User');


ngOnInit() {
  // 1. Show the guide immediately
  this.showMigrationInstructions();

  // 2. Listen for Query Params (Handle the Redirect)
  this.route.queryParams.subscribe(params => {
    const token = params['token'];
    const instanceUrl = params['instanceUrl'];
    const name = params['name'];

    if (token && instanceUrl) {
      console.log('OAuth Callback Detected: Saving session...');
      
      // Update local storage for display/persistence
      if (name) {
        localStorage.setItem('sf_user_name', name);
        this.displayName.set(name);
      }

      // CRITICAL: Update the AuthService signal/storage
      // This ensures this.authService.isLoggedIn() returns true immediately
      this.authService.handleOAuthLogin(token, instanceUrl);

      // Clean the URL so the token isn't visible in the address bar
      this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { token: null, instanceUrl: null, name: null },
        queryParamsHandling: 'merge',
        replaceUrl: true
      });

      this.toastr.success('Connection Verified!', 'Welcome');
      this.loadSalesforceObjects();
      
    } else if (this.authService.isLoggedIn()) {
      // 3. Regular visit: User is already logged in
      const savedName = localStorage.getItem('sf_user_name');
      if (savedName) this.displayName.set(savedName);
      
      this.loadSalesforceObjects();
    } else {
      // 4. Not logged in and no token in URL
      this.router.navigate(['/login']);
    }
  });
}
private loadSalesforceObjects() {
  this.isLoadingObjects = true;
  this.cdr.detectChanges(); // Ensure the spinner shows

  this.migrationService.getAllObjects().subscribe({
    next: (objects) => {
      this.sfObjects = objects;
      this.isLoadingObjects = false;
      this.cdr.detectChanges();
    },
    error: (err) => {
      this.isLoadingObjects = false;
      console.error('Fetch Error:', err);
      
      // If the token is invalid/expired (401), send them back to login
      if (err.status === 401) {
        this.toastr.error('Session expired. Please log in again.');
        this.authService.logout(); // This clears tokens and navigates to /login
      } else {
        this.toastr.error('Could not load Salesforce objects.', 'Connection Error');
      }
      this.cdr.detectChanges();
    }
  });
}

 onCRMSelect(crm: string) {
    setTimeout(() => {
      this.currentStep = 2;
      this.autoNavigate();
      this.cdr.detectChanges();
    }, 300);
  }

  get isDeleteOnlyBatch(): boolean {
    return this.migrationQueue.length > 0 && this.migrationQueue.every(job => job.operationMode === 'delete');
  }

  get hasDeleteInBatch(): boolean {
    return this.migrationQueue.some(job => job.operationMode === 'delete');
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

  closeAllDropdowns() {
    this.mappings.forEach((m) => {
      m.isDropdownOpen = false;
      m.isParentDropdownOpen = false;
    });
    this.isObjectDropdownOpen = false;
    this.isUpsertKeyDropdownOpen = false;
  }

  @HostListener('document:click', ['$event'])
  clickout(event: Event) {
      this.closeAllDropdowns();
  }

  getSfFieldMeta(fieldName: string): any {
    return this.sfFields.find((f) => f.name === fieldName);
  }

  getMissingRequiredFields(): string[] {
    // If it's a delete operation, standard required fields don't apply.
    if (this.operationMode === 'delete') return [];

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

  onOperationModeChange() {
    if (this.operationMode === 'upsert' && !this.targetExtIdField) {
      // Look for fields marked as externalId, unique, or idLookup in Salesforce
      const extIds = this.sfFields.filter(f => f.externalId || f.unique || f.idLookup);
      
      // If there is exactly one obvious choice, auto-select it!
      if (extIds.length === 1) {
        this.selectUpsertKey(extIds[0].name);
        //this.toastr.info(`Automatically selected "${extIds[0].label}" as the Upsert Key.`, 'Smart Select');
      }
    } else if (this.operationMode === 'delete') {
      this.targetExtIdField = '';
    }
  }

  onObjectChangeInMapping(newObject: string) {
    if (!newObject) return;
    this.isLoadingFields = true;
    this.showPreview = false;
    this.targetExtIdField = '';
    this.fetchObjectFields(this.selectedObject);
  }

  private getSimilarity(s1: string, s2: string): number {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) { longer = s2; shorter = s1; }
    const longerLength = longer.length;
    if (longerLength === 0) return 1.0;
    
    // Levenshtein logic
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
      let memoryCount = 0;

      // 1. Load Past Mappings from Memory
      const savedMappingData = localStorage.getItem(`sf_map_${this.selectedObject}`);
      const pastMappings = savedMappingData ? JSON.parse(savedMappingData) : {};

      const normalizeString = (str: string) => {
        return String(str).toLowerCase().replace(/__c$/g, '').replace(/id$/g, '').replace(/[^a-z0-9]/g, '');
      };

      this.mappings.forEach(mapping => {
        if (!mapping.sfField) {
          const rawCsv = mapping.csvField;
          const normalCsv = normalizeString(rawCsv);

          // Strategy A: Check LocalStorage Memory First
          if (pastMappings[rawCsv]) {
            const savedSfField = this.sfFields.find(f => f.name === pastMappings[rawCsv]);
            if (savedSfField) {
              mapping.sfField = savedSfField.name;
              memoryCount++;
              this.onSfFieldChange(mapping);
              return; // Skip to next column
            }
          }

          // Strategy B: Exact Normal Match & Strategy C: Fuzzy Match
          let bestMatch = null;
          let highestScore = 0;

          for (const field of this.sfFields) {
            const normalName = normalizeString(field.name);
            const normalLabel = normalizeString(field.label);

            // Exact normalization match
            if (normalCsv === normalName || normalCsv === normalLabel) {
              bestMatch = field;
              highestScore = 1.0;
              break; 
            }

            // Fuzzy Match (If similarity is 80% or higher)
            const labelScore = this.getSimilarity(normalCsv, normalLabel);
            const nameScore = this.getSimilarity(normalCsv, normalName);
            const bestFieldScore = Math.max(labelScore, nameScore);

            if (bestFieldScore >= 0.8 && bestFieldScore > highestScore) {
              highestScore = bestFieldScore;
              bestMatch = field;
            }
          }

          if (bestMatch) {
            mapping.sfField = bestMatch.name;
            matchCount++;
            this.onSfFieldChange(mapping);
          }
        }
      });

      // Show specific toastr notifications based on what happened
      // if (memoryCount > 0) {
      //   this.toastr.success(`Restored ${memoryCount} mappings from your past templates!`, 'Smart Template');
      // }
      if (matchCount > 0) {
        this.toastr.success(`Auto-mapped ${matchCount} fields successfully.`, 'Auto-Map Complete');
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
        setTimeout(() => {
          const fieldsArray = response.fields ? response.fields : response;
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
      // 1. Group Required fields at the very top
      if (a.isRequired && !b.isRequired) return -1;
      if (!a.isRequired && b.isRequired) return 1;
      
      // 2. Then sort alphabetically
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
        setTimeout(() => { mapping.isLoadingParentFields = true; this.cdr.detectChanges(); });

        this.migrationService.getObjectFields(parentObj).subscribe({
          next: (response: any) => {
            setTimeout(() => {
              const fieldsArray = response.fields ? response.fields : response;
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
    const isDuplicate = this.migrationQueue.some((job) => job.targetObject === this.selectedObject);
    if (isDuplicate) {
      this.toastr.error(`The object "${this.selectedObject}" is already in the queue. Please edit the existing entry instead of adding it again.`, 'Duplicate Object');
      return;
    }

    // if (this.operationMode === 'upsert' && this.getDynamicSequenceError()) {
    //   this.toastr.error(this.getDynamicSequenceError()!, 'Sequence Blocked');
    //   return;
    // }

    const activeMappings = this.mappings.filter((m) => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field.', 'No Mappings');
      return;
    }

    // Validation for Operations
    const hasSfId = activeMappings.some((m) => m.sfField === 'Id');
    if (this.operationMode === 'delete' && !hasSfId) {
      this.toastr.error('Delete operation requires the Salesforce "Id" field to be mapped.', 'Missing ID');
      return;
    }

    if (this.operationMode === 'update' && !this.targetExtIdField && !hasSfId) {
      this.toastr.error('Update requires either a Primary Upsert Key or the standard "Id" field mapped.', 'Missing ID');
      return;
    }

    if (this.operationMode === 'upsert' && !this.targetExtIdField) {
      this.toastr.error('Upsert requires a Primary Upsert Key (External ID).', 'Missing Configuration');
      return;
    }

    const missingFields = this.getMissingRequiredFields();
    if (missingFields.length > 0) {
      this.toastr.error(`Missing required fields: ${missingFields.join(', ')}`, 'Validation Error');
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

    // ---> NEW: Save to Memory ONLY AFTER validations pass <---
    const mapToSave: any = {};
    activeMappings.forEach(m => { mapToSave[m.csvField] = m.sfField; });
    localStorage.setItem(`sf_map_${this.selectedObject}`, JSON.stringify(mapToSave));
    // ---------------------------------------------------------

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
        return;
      }

      const hasSfId = this.confirmedMappings.some((m) => m.sfField === 'Id');
      if (this.operationMode === 'delete' && !hasSfId) {
        this.toastr.error('Delete operation requires the Salesforce "Id" field to be mapped.', 'Missing ID');
        return;
      }
      if (this.operationMode === 'update' && !this.targetExtIdField && !hasSfId) {
        this.toastr.error('Update requires either a Primary Upsert Key or the standard "Id" field mapped.', 'Missing ID');
        return;
      }
      if (this.operationMode === 'upsert' && !this.targetExtIdField) {
        this.toastr.error('Upsert requires a Primary Upsert Key before proceeding.', 'Missing Configuration');
        return;
      }

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

      // ---> NEW: Save to Memory ONLY AFTER validations pass <---
      const mapToSave: any = {};
      this.confirmedMappings.forEach(m => { mapToSave[m.csvField] = m.sfField; });
      localStorage.setItem(`sf_map_${this.selectedObject}`, JSON.stringify(mapToSave));

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

    let totalRows = 0;
    if (this.workbook) {
      this.migrationQueue.forEach(job => {
        const worksheet = this.workbook!.Sheets[job.sheetName];
        const rawData: any[] = utils.sheet_to_json(worksheet);
        totalRows += rawData.length;
      });
    }

    const estimatedBatches = Math.ceil(totalRows / this.batchSize);

   // Dynamic UI Variables based on Operation Type
    const isDeleteOnly = this.isDeleteOnlyBatch;
    const hasDelete = this.hasDeleteInBatch;

    const popupTitle = isDeleteOnly
      ? '<strong class="text-danger">Ready for Data Deletion?</strong>'
      : (hasDelete ? '<strong>Ready for Migration & Deletion?</strong>' : '<strong>Ready for Data Migration?</strong>');

    const confirmBtnText = isDeleteOnly
      ? '<i class="feather icon-trash-2 me-1"></i> Execute Deletion'
      : '<i class="feather icon-zap me-1"></i> Execute ' + (hasDelete ? 'Batch' : 'Migration');

    const confirmBtnClass = isDeleteOnly
      ? 'btn btn-danger btn-lg rounded-pill shadow px-4 mx-2 fw-bold'
      : 'btn btn-primary btn-lg rounded-pill shadow px-4 mx-2 fw-bold';

    const warningText = isDeleteOnly
      ? '<p class="text-danger fw-bold small mt-3 mb-0"><i class="feather icon-alert-triangle me-1"></i> WARNING: Deleted records will be moved to the Salesforce Recycle Bin.</p>'
      : '<p class="text-muted small mt-3 mb-0"><i class="feather icon-shield text-success me-1"></i> Data will be safely chunked to prevent API timeouts.</p>';

    Swal.fire({
      title: popupTitle,
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
        ${warningText}
      `,
      icon: 'question',
      iconColor: '#0d6efd',
      backdrop: `
        rgba(0, 0, 0, 0.4)
        backdrop-filter: blur(8px)
        left top
        no-repeat
      `,
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: '<i class="feather icon-zap me-1"></i> Execute Migration',
      cancelButtonText: 'Review Again',
      customClass: {
        popup: 'rounded-4 shadow-lg border-0',
        title: 'fs-3 fw-bold text-dark',
        confirmButton: confirmBtnClass,
        cancelButton: 'btn btn-white btn-lg rounded-pill shadow-sm px-4 mx-2 border text-muted fw-bold'
      }
    }).then((result) => {

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
                batchSize: this.batchSize
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
    });
  }

showMigrationInstructions() {
    Swal.fire({
      title: '<strong class="text-primary"><i class="feather icon-book-open me-2"></i>Complete Migration Guide</strong>',
      html: `
        <div class="text-start fs-6 text-muted mt-2">
          <p class="mb-2">Please review these critical guidelines to ensure a successful Salesforce migration. <strong>Scroll to read all points.</strong></p>
          
          <div style="max-height: 45vh; overflow-y: auto; overflow-x: hidden; padding-right: 10px;" class="mb-3 border rounded shadow-sm bg-light">
            <ul class="list-group list-group-flush">
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-file-text text-secondary me-2"></i>
                <strong>1. Clean Your Data:</strong> Remove empty columns/rows. Ensure headers are clearly named.
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-layers text-primary me-2"></i>
                <strong>2. Order of Operations:</strong> Always migrate Parent records (e.g., Accounts) <em>before</em> Child records (e.g., Contacts or Opportunities).
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-list text-info me-2"></i>
                <strong>3. Picklist Values:</strong> Your CSV values must exactly match the active picklist values in Salesforce (they are case-sensitive).
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-calendar text-danger me-2"></i>
                <strong>4. Date & Time Formats:</strong> Salesforce prefers standard ISO formats (e.g., <code>YYYY-MM-DD</code>). Ensure Excel hasn't auto-formatted your dates incorrectly.
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-key text-success me-2"></i>
                <strong>5. Upsert Keys:</strong> If updating or upserting, you must map an External ID or Salesforce ID column to prevent duplicate records.
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-alert-circle text-warning me-2"></i>
                <strong>6. Required Fields:</strong> Check Salesforce to ensure you are mapping all universally required fields for your target object.
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-check-square text-secondary me-2"></i>
                <strong>7. Checkboxes:</strong> Use <code>TRUE</code>/<code>FALSE</code>, <code>Yes</code>/<code>No</code>, or <code>1</code>/<code>0</code> for boolean fields.
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-shopping-cart text-dark me-2"></i>
                <strong>8. Product Migration Sequence:</strong> Products and Pricing must be loaded in this exact order: 
                <br><span class="ms-4 small text-dark">① <b>Products</b> (Product2)</span>
                <br><span class="ms-4 small text-danger fw-bold">② Standard Pricebook Entries (Required!)</span>
                <br><span class="ms-4 small text-dark">③ Custom Pricebooks (Pricebook2)</span>
                <br><span class="ms-4 small text-dark">④ Custom Pricebook Entries</span>
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-dollar-sign text-success me-2"></i>
                <strong>9. Pricebook Criteria:</strong> A Product <em>cannot</em> be added to a Custom Pricebook unless it already has an Active Standard Pricebook Entry. Also, ensure your <code>CurrencyIsoCode</code> matches if multi-currency is enabled.
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-users text-info me-2"></i>
                <strong>10. Record Ownership:</strong> Want someone else to own these records? Ensure you map the <code>OwnerId</code> column with the correct Salesforce User IDs. If left blank, you will own all migrated records.
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-check-circle text-secondary me-2"></i>
                <strong>11. Multi-Select Picklists:</strong> If you are mapping to a multi-select picklist, separate multiple values using a semicolon (<code>;</code>) with no extra spaces (e.g., <code>Apples;Oranges;Bananas</code>).
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-map-pin text-danger me-2"></i>
                <strong>12. State & Country Picklists:</strong> If your Salesforce org has State and Country Picklists enabled, your CSV data must perfectly match the configured Integration Values or ISO Codes, or the rows will fail.
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-layout text-primary me-2"></i>
                <strong>13. Record Types:</strong> If your target object uses multiple Record Types, remember to map the <code>RecordTypeId</code> column. Otherwise, all records will default to your personal default Record Type.
              </li>

            </ul>
          </div>

          <div class="alert alert-primary-subtle border-primary-subtle d-flex align-items-center gap-2 mb-0 py-2">
            <i class="feather icon-shield text-primary fs-4"></i>
            <small class="text-dark fw-bold">Tip: Always test your mapping with a small batch (e.g., 5 rows) before running a massive file.</small>
          </div>
        </div>
      `,
      width: '650px',
      showCloseButton: true,
      focusConfirm: false,
      confirmButtonText: '<i class="feather icon-thumbs-up me-1"></i> I Understand, Let\'s Go',
      customClass: {
        confirmButton: 'btn btn-primary rounded-pill px-4 shadow-sm',
        popup: 'rounded-4 shadow-lg border-0'
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
      const rows = document.querySelectorAll('.row.mb-4');
      const newStepElement = rows[rows.length - 1];

      if (newStepElement) {
        newStepElement.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    }, 150);
  }

  resetMigrationSession() {
    this.migrationQueue = [];
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
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.cdr.detectChanges();
  }

getDynamicSequenceWarning(): string | null {
    if (this.operationMode !== 'upsert' || !this.selectedObject) return null;

    for (const mapping of this.mappings) {
      if (mapping.relationalExtIdField && mapping.relationalExtIdField !== 'Id') {
        const parentName = mapping.parentObjectName;
        const isParentInQueue = this.migrationQueue.some(q => q.targetObject === parentName);

        // Soft warning instead of a hard block
        if (!isParentInQueue) {
          return `You are linking to ${parentName} via Legacy ID (${mapping.relationalExtIdField}). Ensure these ${parentName} records already exist in Salesforce, or add a ${parentName} sheet to your queue.`;
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
      // We only block if they have multiple sheets in the WRONG order
      if (this.hasOrderingIssue()) {
        this.toastr.error('Please reorder the queue: Parents (like Accounts) must be above Children.', 'Sequence Error');
        return;
      }
    }
    this.goToReview();
  }
}