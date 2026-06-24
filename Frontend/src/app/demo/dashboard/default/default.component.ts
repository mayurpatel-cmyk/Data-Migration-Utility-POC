/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnInit, inject, ChangeDetectorRef, HostListener, ElementRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook, write } from 'xlsx';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { MigrationService } from 'src/app/services/migration.service';
import { ToastrService } from 'ngx-toastr';
import Swal from 'sweetalert2';
import { AuthService } from '../../Services/auth.service';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs'; 
import { DataTransferService } from 'src/app/services/data-transfer.service';

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
  imports: [CommonModule, FormsModule, CardComponent],
  templateUrl: './default.component.html',
  styleUrls: ['./default.component.scss']
})
export class DefaultComponent implements OnInit {
  private migrationService = inject(MigrationService);
  private cdr = inject(ChangeDetectorRef);
  private toastr = inject(ToastrService);
  private eRef = inject(ElementRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private authService = inject(AuthService);
  private dataTransfer = inject(DataTransferService);

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

  operationMode: string = 'insert';
  parentObjectFieldsCache: { [objectName: string]: any[] } = {};
  batchSize: number = 10000;

  isObjectDropdownOpen = false;
  objectSearchQuery = '';

  isUpsertKeyDropdownOpen = false;
  upsertKeySearchQuery = '';
  displayName = signal('CRM User');

  // --- Real-Time UI State Trackers ---
  activeJobStatus: string = '';
  completedJobsCount: number = 0;

  targetCrmId: string = 'salesforce';
  sourceCrmId: string = 'csv';

  ngOnInit() {
    const navState = history.state;
    this.targetCrmId = navState?.targetCrm || localStorage.getItem('target_crm_slot') || 'salesforce';
    this.sourceCrmId = navState?.sourceCrm || localStorage.getItem('source_crm_slot') || 'csv';

    localStorage.setItem('target_crm_slot', this.targetCrmId);
    localStorage.setItem('source_crm_slot', this.sourceCrmId);

    this.batchSize = this.batchConfig.default;

    const transferred = this.dataTransfer.getValidatedData();

    // Check if we have an array of jobs transferred from Validation
    if (transferred && transferred.data && Array.isArray(transferred.data) && transferred.data.length > 0) {

      const newWorkbook = utils.book_new();
      this.availableSheets = [];

      // 1. Loop through the Validation Jobs and create a multi-sheet Excel file
      transferred.data.forEach((job: any, index: number) => {
        const sheetName = (job.sheetName || `Sheet${index + 1}`).substring(0, 31);
        const worksheet = utils.json_to_sheet(job.results.validRecords);

        utils.book_append_sheet(newWorkbook, worksheet, sheetName);
        this.availableSheets.push(sheetName);
      });

      // Bind the new workbook and file to the UI
      this.workbook = newWorkbook;
      this.selectedFile = new File([write(newWorkbook, { type: 'array', bookType: 'xlsx' })], transferred.fileName || 'Cleaned_Batch.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // --- AUTO-BUILD THE ENTIRE MIGRATION QUEUE ---
      this.migrationQueue = []; 

      transferred.data.forEach((job: any, index: number) => {
        const enhancedMappings: MappingMeta[] = job.mappings.map((m: any) => ({
          csvField: m.csvField,
          sfField: m.sfField,
          type: m.type,
          relationalExtIdField: '',
          parentObjectName: undefined
        }));

        this.migrationQueue.push({
          sheetName: (job.sheetName || `Sheet${index + 1}`).substring(0, 31),
          targetObject: job.targetObject,
          csvHeaders: Object.keys(job.results.validRecords[0] || {}),
          mappings: enhancedMappings,
          operationMode: 'insert', 
          targetExtIdField: job.dedupeKey || ''
        });
      });

      this.currentStep = 3;
      this.selectedObject = '';

      this.toastr.success('Data imported and mapped successfully! Review your queue.', 'Auto-Mapped');
      this.cdr.detectChanges();

    } else {
      setTimeout(() => {
        this.showMigrationInstructions();
      }, 0);
    }

    setTimeout(() => {
      if (this.authService.isLoggedIn()) {
        this.loadTargetObjects();
      } else {
        this.router.navigate(['/login']);
      }
    }, 0);
  }

  private loadTargetObjects() {
    this.isLoadingObjects = true;
    this.cdr.detectChanges();

    this.migrationService.getAllObjects(this.targetCrmId, 'target').subscribe({
      next: (objects) => {
        this.sfObjects = objects;
        setTimeout(() => {
          this.isLoadingObjects = false;
          this.cdr.detectChanges();
        });
      },
      error: (err) => {
        setTimeout(() => {
          this.isLoadingObjects = false;
          this.cdr.detectChanges();
        });

        if (err.status === 401) {
          this.toastr.error('Session expired. Please log in again.');
          this.authService.logout();
        } else {
          // FIX: Removed invalid bitwise | operator that crashed the TypeScript build!
          this.toastr.error(`Could not load objects for ${this.targetCrmId.toUpperCase()}.`, 'Connection Error');
        }
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

  // Dynamically returns which operation modes the selected CRM supports
  get availableOpModes(): string[] {
    const crm = (this.targetCrmId || '').toLowerCase();
    switch (crm) {
      case 'hubspot':
        return ['insert', 'update', 'upsert']; // HubSpot Bulk Delete not natively supported here
      case 'zendesk':
        return ['insert', 'update', 'upsert']; // Zendesk Bulk Delete not natively supported here
      case 'zoho':
      case 'salesforce':
      default:
        return ['insert', 'update', 'upsert', 'delete']; // SF & Zoho support all 4
    }
  }

  get hasDeleteInBatch(): boolean {
    return this.migrationQueue.some(job => job.operationMode === 'delete');
  }

  get batchConfig() {
    const crm = (this.targetCrmId || '').toLowerCase();
    switch (crm) {
      case 'hubspot':
        return { min: 10, max: 100, step: 10, default: 100, tooltip: 'HubSpot max limit: 100' };
      case 'zendesk':
        return { min: 10, max: 100, step: 10, default: 100, tooltip: 'Zendesk max limit: 100' };
      case 'zoho':
        return { min: 10, max: 100, step: 10, default: 100, tooltip: 'Zoho max limit: 100' };
      case 'salesforce':
      default:
        return { min: 100, max: 10000, step: 1000, default: 5000, tooltip: 'Salesforce max limit: 10,000' };
    }
  }

  validateBatchSize() {
    const config = this.batchConfig;
    if (this.batchSize > config.max) {
      this.batchSize = config.max;
      this.toastr.info(`Batch size reduced to ${config.max} to comply with ${this.targetCrmId.toUpperCase()} API limits.`);
    } else if (this.batchSize < config.min) {
      this.batchSize = config.min;
    }
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
    if (fieldName === 'Id') return `Id (Standard ${this.targetCrmId.toUpperCase()} ID)`;
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
    if (this.operationMode === 'delete') return [];
    if (!this.sfFields || this.sfFields.length === 0) return [];

    const crm = (this.targetCrmId || '').toLowerCase();
    const objLower = (this.selectedObject || '').toLowerCase();

    // 1. Get API-defined required fields (Works perfectly for Salesforce)
    let requiredFields = this.sfFields.filter((f) => f.isRequired).map((f) => f.name);

    // Helper to safely suggest a field only if it actually exists in their schema
    const addIfInSchema = (fieldName: string) => {
      if (this.sfFields.some(f => f.name === fieldName) && !requiredFields.includes(fieldName)) {
        requiredFields.push(fieldName);
      }
    };

    const currentlyMappedFields = this.mappings.map((m) => m.sfField).filter((val) => val !== '');

    // 2. Inject CRM-Specific Smart Fallbacks
    if (crm === 'hubspot') {
      if (objLower === 'contacts') addIfInSchema('email');
      if (objLower === 'deals') addIfInSchema('dealname');
      if (objLower === 'tickets') {
        addIfInSchema('hs_pipeline');
        addIfInSchema('hs_pipeline_stage');
      }
      
      // HubSpot Companies Special Rule: Requires EITHER domain OR name
      if (objLower === 'companies') {
        if (!currentlyMappedFields.includes('domain') && !currentlyMappedFields.includes('name')) {
          addIfInSchema('domain'); // Suggest domain as the primary identifier
        }
      }
    } else if (crm === 'zoho') {
      if (objLower === 'leads' || objLower === 'contacts') addIfInSchema('Last_Name');
      if (objLower === 'accounts') addIfInSchema('Account_Name');
      if (objLower === 'deals') addIfInSchema('Deal_Name');
    }

    // 3. Return what's required but hasn't been mapped yet
    return requiredFields.filter((reqField) => !currentlyMappedFields.includes(reqField));
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
    const crm = (this.targetCrmId || '').toLowerCase();
    const objLower = (this.selectedObject || '').toLowerCase();

    if (this.operationMode === 'upsert' && !this.targetExtIdField) {
      
      // CRM-SPECIFIC UPSERT LOGIC
      if (crm === 'hubspot' && objLower === 'contacts') {
        this.selectUpsertKey('email');
      } else if (crm === 'hubspot' && objLower === 'companies') {
        this.selectUpsertKey('domain');
      } else if (crm === 'zendesk') {
        // Zendesk commonly upserts via external_id
        const hasExtId = this.sfFields.find(f => f.name === 'external_id');
        if (hasExtId) this.selectUpsertKey('external_id');
      } else {
        // Default Salesforce/Zoho Logic: Auto-select if there's only 1 external ID field
        const extIds = this.sfFields.filter(f => f.externalId || f.unique || f.idLookup);
        if (extIds.length === 1) {
          this.selectUpsertKey(extIds[0].name);
        }
      }

    } else if (this.operationMode === 'delete') {
      this.targetExtIdField = '';
    }
  }

  // Dynamically returns the naming convention for fields/properties
  get targetFieldLabel(): string {
    const crm = (this.targetCrmId || '').toLowerCase();
    switch (crm) {
      case 'hubspot': return 'HubSpot Property';
      case 'zoho': return 'Zoho Module Field';
      case 'zendesk': return 'Zendesk Ticket Field';
      case 'salesforce':
      default: return 'Salesforce Field';
    }
  }

  // Dynamically returns the naming convention for records/objects
  get targetObjectLabel(): string {
    const crm = (this.targetCrmId || '').toLowerCase();
    switch (crm) {
      case 'zoho': return 'Zoho Module';
      case 'hubspot':
      case 'zendesk':
        return 'Target Object';
      case 'salesforce':
      default: return 'Salesforce Object';
    }
  }

  // Dynamically determines if the CRM supports complex nested External ID lookups
  get supportsRelationalLookups(): boolean {
    const crm = (this.targetCrmId || '').toLowerCase();
    // Currently, only Salesforce natively supports mapping parent relationships 
    // via dynamic External IDs inside a standard bulk payload.
    return crm === 'salesforce';
  }

  moveQueueItemUp(index: number) {
    if (index > 0) {
      const item = this.migrationQueue.splice(index, 1)[0];
      this.migrationQueue.splice(index - 1, 0, item);
      this.previewingItemIndex = null;
      this.showPreview = false;
      this.cdr.detectChanges();
    }
  }

  moveQueueItemDown(index: number) {
    if (index < this.migrationQueue.length - 1) {
      const item = this.migrationQueue.splice(index, 1)[0];
      this.migrationQueue.splice(index + 1, 0, item);
      this.previewingItemIndex = null;
      this.showPreview = false;
      this.cdr.detectChanges();
    }
  }

  // --- SAVED MAPPING TEMPLATES ---
  async saveMappingTemplate() {
    const activeMappings = this.mappings.filter(m => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Map at least one field to save a template.', 'Cannot Save');
      return;
    }

    const { value: templateName } = await Swal.fire({
      title: 'Save Mapping Template',
      input: 'text',
      inputLabel: 'Give this template a name (e.g., Monthly Sales Import)',
      inputPlaceholder: 'Template Name...',
      showCancelButton: true,
      confirmButtonColor: '#0d6efd',
      inputValidator: (value) => {
        if (!value) return 'You need to write a name!';
        return null;
      }
    });

    if (templateName) {
      const template = {
        targetObject: this.selectedObject,
        operationMode: this.operationMode,
        targetExtIdField: this.targetExtIdField,
        mappings: activeMappings
      };

      let templates = JSON.parse(localStorage.getItem(`${this.targetCrmId}_mapping_templates`) || '[]');
      templates = templates.filter((t: any) => t.name !== templateName);
      templates.push({ name: templateName, data: template });
      localStorage.setItem(`${this.targetCrmId}_mapping_templates`, JSON.stringify(templates));

      this.toastr.success(`Template "${templateName}" saved successfully!`, 'Template Saved');
    }
  }

  async loadMappingTemplate() {
    const templates = JSON.parse(localStorage.getItem(`${this.targetCrmId}_mapping_templates`) || '[]');
    const objectTemplates = templates.filter((t: any) => t.data.targetObject === this.selectedObject);

    if (objectTemplates.length === 0) {
      this.toastr.info(`No saved templates found for ${this.selectedObject}.`, 'No Templates');
      return;
    }

    const options: any = {};
    objectTemplates.forEach((t: any) => { options[t.name] = t.name; });

    const { value: selectedName } = await Swal.fire({
      title: 'Load Template',
      input: 'select',
      inputOptions: options,
      inputPlaceholder: '-- Select a Saved Template --',
      showCancelButton: true,
      confirmButtonColor: '#198754'
    });

    if (selectedName) {
      const t = objectTemplates.find((x: any) => x.name === selectedName).data;
      this.operationMode = t.operationMode;
      this.targetExtIdField = t.targetExtIdField;

      this.mappings.forEach(m => { m.sfField = ''; m.parentObjectName = undefined; m.relationalExtIdField = ''; });

      t.mappings.forEach((savedMap: any) => {
        const match = this.mappings.find(m => m.csvField === savedMap.csvField);
        if (match) {
          match.sfField = savedMap.sfField;
          match.parentObjectName = savedMap.parentObjectName;
          match.relationalExtIdField = savedMap.relationalExtIdField;

          if (match.parentObjectName) {
            this.onSfFieldChange(match);
          }
        }
      });

      this.toastr.success(`Loaded "${selectedName}"!`, 'Template Loaded');
      this.cdr.detectChanges();
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

      const savedMappingData = localStorage.getItem(`${this.targetCrmId}_map_${this.selectedObject}`);
      const pastMappings = savedMappingData ? JSON.parse(savedMappingData) : {};

      const normalizeString = (str: string) => {
        return String(str).toLowerCase().replace(/__c$/g, '').replace(/id$/g, '').replace(/[^a-z0-9]/g, '');
      };

      this.mappings.forEach(mapping => {
        if (!mapping.sfField) {
          const rawCsv = mapping.csvField;
          const normalCsv = normalizeString(rawCsv);

          if (pastMappings[rawCsv]) {
            const savedSfField = this.sfFields.find(f => f.name === pastMappings[rawCsv]);
            if (savedSfField) {
              mapping.sfField = savedSfField.name;
              memoryCount++;
              this.onSfFieldChange(mapping);
              return;
            }
          }

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
            mapping.sfField = bestMatch.name;
            matchCount++;
            this.onSfFieldChange(mapping);
          }
        }
      });

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
    this.migrationService.getObjectFields(this.targetCrmId, objectName, 'target').subscribe({
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
                
                this.migrationService.getObjectFields(this.targetCrmId, m.parentObjectName, 'target').subscribe({
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
      if (a.isRequired && !b.isRequired) return -1;
      if (!a.isRequired && b.isRequired) return 1;

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

    if (this.supportsRelationalLookups && fieldMeta && fieldMeta.type === 'reference' && fieldMeta.referenceTo && fieldMeta.referenceTo.length > 0) {
      const parentObj = fieldMeta.referenceTo[0];
      mapping.parentObjectName = parentObj;

      if (!this.parentObjectFieldsCache[parentObj]) {
        setTimeout(() => { mapping.isLoadingParentFields = true; this.cdr.detectChanges(); });

        this.migrationService.getObjectFields(this.targetCrmId, parentObj, 'target').subscribe({
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

    const activeMappings = this.mappings.filter((m) => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field.', 'No Mappings');
      return;
    }

    const hasSfId = activeMappings.some((m) => m.sfField === 'Id');
    if (this.operationMode === 'delete' && !hasSfId) {
      this.toastr.error(`Delete operation requires the ${this.targetCrmId.toUpperCase()} "Id" field to be mapped.`, 'Missing ID');
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

    const mapToSave: any = {};
    activeMappings.forEach(m => { mapToSave[m.csvField] = m.sfField; });
    localStorage.setItem(`${this.targetCrmId}_map_${this.selectedObject}`, JSON.stringify(mapToSave));

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
        this.toastr.error(`Delete operation requires the ${this.targetCrmId.toUpperCase()} "Id" field to be mapped.`, 'Missing ID');
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

      const mapToSave: any = {};
      this.confirmedMappings.forEach(m => { mapToSave[m.csvField] = m.sfField; });
      localStorage.setItem(`${this.targetCrmId}_map_${this.selectedObject}`, JSON.stringify(mapToSave));

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

  // --- DOWNLOAD MAPPING RECEIPT (AUDIT LOG) ---
  downloadMappingReceipt() {
    if (this.migrationQueue.length === 0) {
      this.toastr.warning('There are no mappings to export.', 'Empty Queue');
      return;
    }

    let csvContent = 'Target Object,Source Sheet,Operation Mode,External ID Key,CSV Column,Destination Field,Relational Lookup Key\n';

    this.migrationQueue.forEach(job => {
      const activeMappings = job.mappings.filter(m => m.sfField && m.sfField !== '');

      activeMappings.forEach(m => {
        const safeCsvCol = `"${m.csvField.replace(/"/g, '""')}"`;
        const safeSfField = `"${m.sfField.replace(/"/g, '""')}"`;
        const relation = m.type === 'reference' && m.relationalExtIdField ? `Linked via ${m.relationalExtIdField}` : 'N/A';
        const safeExtId = job.targetExtIdField || 'N/A';

        csvContent += `"${job.targetObject}","${job.sheetName}","${job.operationMode}","${safeExtId}",${safeCsvCol},${safeSfField},"${relation}"\n`;
      });
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;

    const dateStr = new Date().toISOString().split('T')[0];
    link.download = `${this.targetCrmId.toUpperCase()}_Mapping_Receipt_${dateStr}.csv`;

    link.click();
    window.URL.revokeObjectURL(url);

    this.toastr.info('Mapping receipt downloaded. Keep this for your audit records!', 'Receipt Generated');
  }

  // --- UPGRADED: Sequential Batch Processing ---
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
      ? '<p class="text-danger fw-bold small mt-3 mb-0"><i class="feather icon-alert-triangle me-1"></i> WARNING: Deleted records will be moved to the CRM Recycle Bin.</p>'
      : '<p class="text-muted small mt-3 mb-0"><i class="feather icon-shield text-success me-1"></i> Data will be safely chunked by the server to prevent API timeouts.</p>';

    Swal.fire({
      title: popupTitle,
      html: `
        <div class="p-3 bg-light rounded-4 border border-secondary-subtle text-start mb-2 mt-3 shadow-inner">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <span class="text-muted fw-bold small text-uppercase tracking-wide">Total Records</span>
            <span class="fs-4 fw-bold text-dark">${totalRows.toLocaleString()}</span>
          </div>
          <div class="d-flex justify-content-between align-items-center pt-2">
            <span class="text-muted fw-bold small text-uppercase tracking-wide">Execution Plan</span>
            <span class="badge bg-dark text-white px-3 py-2 rounded-pill shadow-sm">
              <i class="feather icon-layers me-1"></i> Server Managed
            </span>
          </div>
        </div>
        ${warningText}
      `,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: confirmBtnText,
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
        this.completedJobsCount = 0;
        this.activeJobStatus = `Initializing live connection to server...`;
        this.cdr.detectChanges();

        this.authService.refreshToken().subscribe({
          next: () => {
            const baseUrl = 'http://localhost:8000'; 
            const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws/migrate';
            const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          this.activeJobStatus = `Connection established. Preparing payload...`;
          this.cdr.detectChanges();

          const token = localStorage.getItem('supabase_token') || '';

          const payload = {
            authToken: token,
            queue: this.migrationQueue.map(job => {
                let parsedSourceRecords = undefined;

                if (this.sourceCrmId === 'csv' && this.workbook) {
                    const worksheet = this.workbook.Sheets[job.sheetName];
                    parsedSourceRecords = utils.sheet_to_json(worksheet);
                }

                return {
                    ...job,
                    sourceCrmId: this.sourceCrmId, 
                    targetCrmId: this.targetCrmId, 
                    batchSize: this.batchSize,
                    sourceRecords: parsedSourceRecords
                };
            })
          };

          ws.send(JSON.stringify(payload));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          
          this.activeJobStatus = data.log;
          
          if (data.log.includes('Completed:')) {
            this.completedJobsCount++;
          }
          
          this.cdr.detectChanges();

          if (data.status === 'Finished' || data.status === 'Failed') {
              this.isMigrating = false;
              
              if (data.successData || data.errorData) {
                  this.successfulRecords = data.successData || [];
                  this.failedRecords = data.errorData || [];
                  this.migrationSummary = { 
                      success: this.successfulRecords.length, 
                      failed: this.failedRecords.length 
                  };
              }

              if (data.status === 'Finished') {
                  this.toastr.success('Migration sequence complete.', 'Done');
              } else {
                  this.toastr.error('Migration encountered a fatal error. Check logs.', 'Failed');
              }

              this.currentStep = 5;
              this.autoNavigate();
              this.cdr.detectChanges();
              
              ws.close();
          }
        };

        ws.onerror = (error) => {
          this.isMigrating = false;
          this.toastr.error('Lost connection to the migration server.', 'Network Error');
          this.activeJobStatus = 'Connection Error';
          this.cdr.detectChanges();
        };

        ws.onclose = (event) => {
          if (this.isMigrating) {
             this.isMigrating = false;
             this.toastr.warning('The server closed the connection unexpectedly.', 'Disconnected');
             this.cdr.detectChanges();
          }
        };
      },
      error: () => {
            this.isMigrating = false;
            this.toastr.error('Authentication expired. Please log in again.');
            this.router.navigate(['/login']);
          }
        });
      }

    });
  }

  showMigrationInstructions() {
    Swal.fire({
      title: `<strong class="text-primary"><i class="feather icon-book-open me-2"></i>Complete Migration Guide</strong>`,
      html: `
        <div class="text-start fs-6 text-muted mt-2">
          <p class="mb-2">Please review these critical guidelines to ensure a successful ${this.targetCrmId.toUpperCase()} migration. <strong>Scroll to read all points.</strong></p>
          
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
                <strong>3. Picklist Values:</strong> Your CSV values must exactly match the active picklist values in ${this.targetCrmId.toUpperCase()} (they are case-sensitive).
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-calendar text-danger me-2"></i>
                <strong>4. Date & Time Formats:</strong> ${this.targetCrmId.toUpperCase()} prefers standard ISO formats (e.g., <code>YYYY-MM-DD</code>). Ensure Excel hasn't auto-formatted your dates incorrectly.
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-key text-success me-2"></i>
                <strong>5. Upsert Keys:</strong> If updating or upserting, you must map an External ID or ${this.targetCrmId.toUpperCase()} ID column to prevent duplicate records.
              </li>
              
              <li class="list-group-item bg-white py-3">
                <i class="feather icon-alert-circle text-warning me-2"></i>
                <strong>6. Required Fields:</strong> Check ${this.targetCrmId.toUpperCase()} to ensure you are mapping all universally required fields for your target object.
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
                <strong>10. Record Ownership:</strong> Want someone else to own these records? Ensure you map the <code>OwnerId</code> column with the correct User IDs. If left blank, you will own all migrated records.
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-check-circle text-secondary me-2"></i>
                <strong>11. Multi-Select Picklists:</strong> If you are mapping to a multi-select picklist, separate multiple values using a semicolon (<code>;</code>) with no extra spaces (e.g., <code>Apples;Oranges;Bananas</code>).
              </li>

              <li class="list-group-item bg-white py-3">
                <i class="feather icon-map-pin text-danger me-2"></i>
                <strong>12. State & Country Picklists:</strong> If your ${this.targetCrmId.toUpperCase()} org has State and Country Picklists enabled, your CSV data must perfectly match the configured Integration Values or ISO Codes, or the rows will fail.
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

    this.activeJobStatus = '';
    this.completedJobsCount = 0;

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

        if (!isParentInQueue) {
          return `You are linking to ${parentName} via Legacy ID (${mapping.relationalExtIdField}). Ensure these ${parentName} records already exist in your Target CRM, or add a ${parentName} sheet to your queue.`;
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
      if (this.hasOrderingIssue()) {
        this.toastr.error('Complex circular dependency detected. Please check your external IDs.', 'Sequence Error');
        return;
      }
    }
    this.goToReview();
  }
}