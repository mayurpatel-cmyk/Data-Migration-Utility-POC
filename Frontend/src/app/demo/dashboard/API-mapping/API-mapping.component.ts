import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, ChangeDetectorRef, NgZone, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from 'src/app/theme/shared/components/breadcrumbs/breadcrumbs.component';
import { MappingApiService } from 'src/app/services/mapping-api.service';

interface FieldMeta {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  referenceTo?: string[];
  relationshipName?: string;
}

interface MappingRow {
  sourceField: string;
  sourceLabel: string;
  targetField: string;
  isDropdownOpen?: boolean; 
  searchQuery?: string;
  relationalExtIdField?: string;
  parentObjectName?: string;
}

interface CrmEntity {
  name: string;
  label: string;
}

@Component({
  selector: 'app-api-mapping',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent],
  templateUrl: './API-mapping.component.html',
  styleUrls: ['./API-mapping.component.scss']
})
export class ApiMappingComponent implements OnInit {
  private router = inject(Router);
  private mappingApi = inject(MappingApiService);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  // CRM Identifiers from previous step
  sourceCrmId: string = '';
  targetCrmId: string = '';
  sourceSystem = 'Unknown';
  targetSystem = 'Unknown';

  // Dynamic Entity Lists for Dropdowns
  sourceEntities: CrmEntity[] = [];
  targetEntities: CrmEntity[] = [];

  selectedSourceObject = '';
  selectedTargetObject = '';
  isLoading = false;

  // Data Preview Variables
  previewHeaders: string[] = [];
  previewRecords: any[] = [];

  // Mapping Variables
  targetFields: FieldMeta[] = [];
  mappings: MappingRow[] = [];
  externalIdField = '';
  mappedCount = 0;
  isStrictMapping = false;

  // Execution Variables
  jobStatus = 'Idle';
  logMessages: string[] = [];
  customQuery: string = '';
  queryError: string | null = null;
  isPreviewLoading = false;
  sourceFields: FieldMeta[] = [];
  successData: any[] = [];
  errorData: any[] = [];
  aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
  validationResults: any = null;
  isValidating = false;
  errorCurrentPage: number = 1;
  errorPageSize: number = 10;
  
  isSourceDropdownOpen = false;
  sourceSearchQuery = '';
  isTargetDropdownOpen = false;
  targetSearchQuery = '';
  
  operationMode: string = 'insert';
  batchSize: number = 5000;
  
  // --- MULTI-OBJECT QUEUE VARIABLES ---
  migrationQueue: any[] = [];

  ngOnInit(): void {
    this.sourceSystem = localStorage.getItem('source_crm_slot') || 'Zendesk';
    this.targetSystem = localStorage.getItem('target_crm_slot') || 'Salesforce';

    const navState = history.state;
    this.sourceCrmId = navState?.sourceCrm || localStorage.getItem('source_crm_slot') || 'msdynamics';
    this.targetCrmId = navState?.targetCrm || localStorage.getItem('target_crm_slot') || 'salesforce';

    this.preloadEntirePage();
  }

  @HostListener('document:click', ['$event'])
  clickout(event: Event) {
    this.closeAllDropdowns();
  }

  onOperationModeChange() {
    if (this.operationMode === 'delete') {
      this.externalIdField = '';
    }
  }

  closeAllDropdowns() {
    this.mappings.forEach(m => m.isDropdownOpen = false);
    this.isSourceDropdownOpen = false;
    this.isTargetDropdownOpen = false;
  }

  toggleDropdown(mapping: any, event: Event) {
    event.stopPropagation();
    const wasOpen = mapping.isDropdownOpen;
    this.closeAllDropdowns();
    mapping.isDropdownOpen = !wasOpen;
    if (mapping.isDropdownOpen) mapping.searchQuery = '';
  }

  isReferenceField(fieldName: string): boolean {
  if (!fieldName) return false;
  const fieldMeta = this.targetFields.find(f => f.name === fieldName);

  if (!fieldMeta) return false;

  // 1. Trust the API metadata first
  if (fieldMeta.type === 'reference' || (fieldMeta.referenceTo && fieldMeta.referenceTo.length > 0)) {
    return true;
  }

  // 2. Fallback: If API missed it, but it follows Salesforce lookup naming conventions
  // (e.g., AccountId, OwnerId). We explicitly exclude the primary 'Id' field.
  if (fieldName !== 'Id' && fieldName.endsWith('Id')) {
    return true;
  }

  return false;
}

  selectField(mapping: any, fieldName: string) {
  mapping.targetField = fieldName;
  mapping.isDropdownOpen = false;
  
  if (this.isReferenceField(fieldName)) {
    // If it is a reference, default the Ext ID to 'Id' so the user knows what to type
    mapping.relationalExtIdField = 'Id';
  } else {
    // CRITICAL: Clear it out if they switch to a normal text/string field
    mapping.relationalExtIdField = undefined; 
  }
  
  this.updateMappedCount();
}

  getFilteredTargetFields(query: string | undefined, sourceFieldName: string): any[] {
    let filtered = this.targetFields;

    // --- STRICT MAPPING LOGIC ---
    if (this.isStrictMapping) {
      const sourceMeta = this.sourceFields.find(f => f.name === sourceFieldName);
      
      if (sourceMeta && sourceMeta.type) {
        filtered = filtered.filter(t => {
          // Allow exact type matches. 
          // (We also allow 'string' to map to 'picklist' or 'reference' as strings act as universal identifiers)
          if (sourceMeta.type === 'string' && ['string', 'picklist', 'reference'].includes(t.type || '')) {
            return true;
          }
          return t.type === sourceMeta.type;
        });
      }
    }

    // --- SEARCH LOGIC ---
    if (query) {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter((f) => 
        f.label.toLowerCase().includes(lowerQuery) || 
        f.name.toLowerCase().includes(lowerQuery)
      );
    }

    return filtered;
  }

  getTargetFieldLabel(fieldName: string): string {
    if (!fieldName) return '';
    const field = this.targetFields.find((f) => f.name === fieldName);
    // Show Label + API Name for the mapped target fields
    return field ? `${field.label} (${field.name})` : fieldName;
  }

  toggleSourceDropdown(event: Event) {
    event.stopPropagation();
    const wasOpen = this.isSourceDropdownOpen;
    this.closeAllDropdowns();
    this.isSourceDropdownOpen = !wasOpen;
    if (this.isSourceDropdownOpen) this.sourceSearchQuery = '';
  }

  toggleTargetDropdown(event: Event) {
    event.stopPropagation();
    if (!this.selectedSourceObject) return; 
    
    const wasOpen = this.isTargetDropdownOpen;
    this.closeAllDropdowns();
    this.isTargetDropdownOpen = !wasOpen;
    if (this.isTargetDropdownOpen) this.targetSearchQuery = '';
  }

  selectSourceEntity(entityName: string) {
    this.selectedSourceObject = entityName;
    this.isSourceDropdownOpen = false;
    this.loadMetadata();
  }

  selectTargetObject(objName: string) {
    this.selectedTargetObject = objName;
    this.isTargetDropdownOpen = false;
    this.loadMetadata();
  }

  getFilteredSourceEntities(): any[] {
    if (!this.sourceSearchQuery) return this.sourceEntities;
    const lowerQuery = this.sourceSearchQuery.toLowerCase();
    return this.sourceEntities.filter(e => 
      e.label.toLowerCase().includes(lowerQuery) || 
      e.name.toLowerCase().includes(lowerQuery)
    );
  }

  getFilteredTargetEntities(): any[] {
    if (!this.targetSearchQuery) return this.targetEntities;
    const lowerQuery = this.targetSearchQuery.toLowerCase();
    return this.targetEntities.filter(e => 
      e.label.toLowerCase().includes(lowerQuery) || 
      e.name.toLowerCase().includes(lowerQuery)
    );
  }

  getSourceEntityLabel(entityName: string): string {
    if (!entityName) return '';
    const entity = this.sourceEntities.find(e => e.name === entityName);
    // Dynamically show Label + API Name for any CRM
    return entity ? `${entity.label} (${entity.name})` : entityName;
  }

  getTargetObjectLabel(objName: string): string {
    if (!objName) return '';
    const obj = this.targetEntities.find(e => e.name === objName);
    // Dynamically show Label + API Name for any CRM
    return obj ? `${obj.label} (${obj.name})` : objName;
  }

  get paginatedErrorRecords() {
    if (!this.validationResults?.invalidRecords) return [];
    const records = this.validationResults.invalidRecords;
    const start = (this.errorCurrentPage - 1) * this.errorPageSize;
    return records.slice(start, start + this.errorPageSize);
  }

  get errorTotalPages() {
    if (!this.validationResults?.invalidRecords) return 1;
    const total = this.validationResults.invalidRecords.length;
    return Math.ceil(total / this.errorPageSize) || 1;
  }

  get currentErrorMaxBound() {
    if (!this.validationResults?.invalidRecords) return 0;
    const total = this.validationResults.invalidRecords.length;
    return Math.min(this.errorCurrentPage * this.errorPageSize, total);
  }

  nextErrorPage() {
    if (this.errorCurrentPage < this.errorTotalPages) this.errorCurrentPage++;
  }

  prevErrorPage() {
    if (this.errorCurrentPage > 1) this.errorCurrentPage--;
  }

  get queryContext() {
    const crm = this.sourceCrmId.toLowerCase();
    
    if (crm === 'zendesk') {
      return {
        title: 'Zendesk Search Filter',
        placeholder: "e.g., type:ticket status<solved created>2023-01-01",
        helpText: "Use Zendesk native search syntax to filter by tags, status, or dates.",
        icon: 'icon-search',
        buttonText: 'Apply Filter',
        loadingText: 'Filtering...'
      };
    } else if (crm === 'salesforce') {
      return {
        title: 'SOQL Query Editor',
        placeholder: "e.g., StageName = 'Closed Won' AND Amount > 5000",
        helpText: "Enter the WHERE clause for your Salesforce SOQL query (omit 'SELECT' and 'WHERE').",
        icon: 'icon-database',
        buttonText: 'Run Query',
        loadingText: 'Querying...'
      };
    } else {
      return {
        title: `${this.sourceSystem} Query Editor`,
        placeholder: "e.g., status = 'Active' OR created_at > '2024-01-01'",
        helpText: `Enter the specific database query to extract records from ${this.sourceSystem}.`,
        icon: 'icon-terminal',
        buttonText: 'Run Query',
        loadingText: 'Querying...'
      };
    }
  }

  scrollToBottom() {
    const logContainer = document.querySelector('.bg-dark.overflow-auto, .bg-light.overflow-auto, .shadow-inner');
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    const terminalCard = document.getElementById('execution-terminal');
    if (terminalCard) {
      terminalCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }

  async applyFilter() {
    if (!this.customQuery || !this.selectedSourceObject) return;

    if (!this.validateQuery()) {
      setTimeout(() => this.scrollToBottom(), 10); 
      return; 
    }

    this.isPreviewLoading = true;
    this.cdr.detectChanges(); 

    const payload = {
      crmId: this.sourceCrmId,
      objectName: this.selectedSourceObject,
      query: this.customQuery,
      sfToken: localStorage.getItem('sf_token') || '',
      sfInstance: localStorage.getItem('sf_instance_url') || '',
      zdToken: localStorage.getItem('zd_token') || '',
      zdSubdomain: localStorage.getItem('zd_subdomain') || ''
    };

    try {
      const response = await fetch('http://localhost:8000/api/metadata/preview-filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error("Failed to fetch filtered data.");
      
      const data = await response.json();
      this.previewRecords = data.records || [];
      this.logMessages = [...this.logMessages, `System: Source preview updated using filter -> [${this.customQuery}]`];

    } catch (error) {
      console.error('Filter Error:', error);
      this.logMessages = [...this.logMessages, 'Error: Failed to apply filter. Check your query syntax.'];
    } finally {
      this.isPreviewLoading = false;
      this.cdr.detectChanges(); 
    }
  }

  private logError(message: string) {
    this.logMessages = [...this.logMessages, message];
  }

  private logWarning(message: string) {
    this.logMessages = [...this.logMessages, message];
  }

  queueAnotherObject() {
    const activeMappings = this.mappings.filter(m => m.targetField !== '');
    
    if (activeMappings.length === 0) {
      this.logError('❌ Queue Error: Please map at least one field before queueing.');
      return;
    }

    const isDuplicate = this.migrationQueue.some((job) => job.targetObject === this.selectedTargetObject);
    if (isDuplicate) {
      this.logError(`❌ Queue Error: ${this.selectedTargetObject} is already in the queue! Please edit the existing entry.`);
      return;
    }

    const enhancedMappings = activeMappings.map(m => {
      const fieldMeta = this.targetFields.find(t => t.name === m.targetField);
      const isRef = this.isReferenceField(m.targetField);
      return {
        sourceField: m.sourceField,
        targetField: m.targetField,
        type: isRef ? 'reference' : fieldMeta?.type,
        referenceTo: fieldMeta?.referenceTo,
        relationshipName: fieldMeta?.relationshipName,
        relationalExtIdField: m.relationalExtIdField || 'Id', 
        parentObjectName: m.parentObjectName || (fieldMeta?.referenceTo ? fieldMeta.referenceTo[0] : undefined)
      };
    });

    const job = {
      sourceObject: this.selectedSourceObject,
      targetObject: this.selectedTargetObject,
      extractionQuery: this.customQuery,
      mappings: enhancedMappings,
      operationMode: this.operationMode,
      batchSize: this.batchSize,
      externalIdField: this.externalIdField,
      
      sfToken: localStorage.getItem('sf_token') || '',
      sfInstance: localStorage.getItem('sf_instance_url') || '',
      zdToken: localStorage.getItem('zd_token') || '',
      zdSubdomain: localStorage.getItem('zd_subdomain') || ''
    };

    this.migrationQueue.push(job);
    this.logMessages = [...this.logMessages, `📦 System: ${this.selectedSourceObject} ➔ ${this.selectedTargetObject} added to the Execution Queue.`];

    // Reset UI to Skeleton State
    this.selectedSourceObject = '';
    this.selectedTargetObject = '';
    this.mappings = [];
    this.customQuery = '';
    this.queryError = null;
    this.previewRecords = [];
    this.previewHeaders = [];
    this.aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
    
    this.cdr.detectChanges();
    
    // Smoothly scroll down to the Queue Table!
    setTimeout(() => {
      const queueCard = document.getElementById('queue-section');
      if (queueCard) {
        queueCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 50);
  }

  removeFromQueue(index: number) {
    const removed = this.migrationQueue.splice(index, 1)[0];
    this.logMessages = [...this.logMessages, `🗑️ System: Removed ${removed.targetObject} from the queue.`];
  }

  moveQueueItemUp(index: number) {
    if (index > 0) {
      const item = this.migrationQueue.splice(index, 1)[0];
      this.migrationQueue.splice(index - 1, 0, item);
    }
  }

  moveQueueItemDown(index: number) {
    if (index < this.migrationQueue.length - 1) {
      const item = this.migrationQueue.splice(index, 1)[0];
      this.migrationQueue.splice(index + 1, 0, item);
    }
  }

  editQueuedItem(index: number) {
    const item = this.migrationQueue.splice(index, 1)[0];
    this.selectedSourceObject = item.sourceObject;
    this.selectedTargetObject = item.targetObject;
    this.customQuery = item.extractionQuery;
    this.operationMode = item.operationMode;
    this.batchSize = item.batchSize;
    this.externalIdField = item.externalIdField;
    
    this.isLoading = true;
    this.cdr.detectChanges();
    
    forkJoin({
      sourceData: this.mappingApi.getFields(this.sourceCrmId, this.selectedSourceObject),
      targetData: this.mappingApi.getFields(this.targetCrmId, this.selectedTargetObject)
    }).subscribe({
      next: ({ sourceData, targetData }) => {
        this.targetFields = targetData.fields || [];
        this.sourceFields = sourceData.fields || [];
        this.previewHeaders = sourceData.headers || [];
        this.previewRecords = sourceData.sampleRecords || [];
        
        this.mappings = (sourceData.fields || []).map((field: any) => {
          const savedMap = item.mappings.find((m: any) => m.sourceField === field.name);
          return {
            sourceField: field.name,
            // NEW: Embed the API Name here as well
            sourceLabel: `${field.label} (${field.name})`,
            targetField: savedMap ? savedMap.targetField : ''
          };
        });
        
        this.updateMappedCount();
        this.isLoading = false;
        this.cdr.detectChanges();
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
        this.logMessages = [...this.logMessages, `✏️ System: Loaded ${this.selectedTargetObject} into editor.`];
      }
    });
  }

  validateQuery(): boolean {
    this.queryError = null; 
    if (!this.customQuery) return true;

    const queryLower = this.customQuery.trim().toLowerCase();
    const crm = this.sourceCrmId.toLowerCase();

    if (crm === 'zendesk') {
      if (queryLower.startsWith('select ') || queryLower.includes(' from ') || queryLower.includes(' where ')) {
        this.queryError = "Zendesk doesn't support SQL. Format: type:ticket status<solved created>2023-01-01";
      } else if (queryLower.includes(',')) {
        this.queryError = "Do not use commas. Format: status:open tags:urgent";
      } else if (queryLower.includes(' = ')) {
        this.queryError = "Use colons for exact matches. Format: status:open";
      } else if (queryLower.includes('%')) {
        this.queryError = "Use '*' for wildcards. Format: name:tech*";
      } else if (queryLower.includes('!=') || queryLower.includes('<>')) {
        this.queryError = "Use '-' to exclude a value. Format: -status:closed";
      } else if (queryLower.includes('type:')) {
        this.logWarning(`⚠️ Notice: You don't need to type "type:...". The system applies it automatically!`);
      }
    } else if (crm === 'salesforce') {
      if (queryLower.startsWith('select ') || queryLower.includes(' where ')) {
        this.queryError = "Enter conditions only. Format: Amount > 5000 AND StageName = 'Closed Won'";
      } else if (queryLower.includes('limit ') || queryLower.includes('order by ')) {
        this.queryError = "Do not use LIMIT. The engine handles pagination automatically.";
      } else if (queryLower.includes('*')) {
        this.queryError = "Use '%' for wildcards. Format: Name LIKE 'Tech%'";
      } else if (queryLower.endsWith(';')) {
        this.queryError = "Do not end your query with a semicolon (;).";
      }
    }

    if (this.queryError) {
      this.logError(`❌ Validation Error: ${this.queryError}`);
      return false;
    }
    return true; 
  }

  preloadEntirePage() {
    this.isLoading = true;
    this.cdr.detectChanges(); 

    forkJoin({
      sourceObjs: this.mappingApi.getObjects(this.sourceCrmId),
      targetObjs: this.mappingApi.getObjects(this.targetCrmId)
    }).subscribe({
      next: ({ sourceObjs, targetObjs }) => {
        this.sourceEntities = sourceObjs || [];
        this.targetEntities = targetObjs || [];

        if (this.sourceEntities.length > 0) {
          const defaultSrc = this.sourceEntities.find(
            (e) => e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('ticket')
          );
          this.selectedSourceObject = defaultSrc ? defaultSrc.name : this.sourceEntities[0].name;
        }

        if (this.targetEntities.length > 0) {
          const defaultTgt = this.targetEntities.find(
            (e) => e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('user')
          );
          this.selectedTargetObject = defaultTgt ? defaultTgt.name : this.targetEntities[0].name;
        }

        this.cdr.detectChanges();
        this.loadMetadata();
      },
      error: (err) => {
        console.error('Failed to preload base entity dropdowns:', err);
        this.logMessages.unshift(`Configuration Error: Could not fetch core CRM schemas.`);
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  insertFieldIntoQuery(event: Event) {
    const selectElement = event.target as HTMLSelectElement;
    const fieldName = selectElement.value;
    
    if (!fieldName) return;

    if (!this.customQuery) {
      this.customQuery = fieldName;
    } else {
      this.customQuery += ` ${fieldName}`;
    }
    selectElement.value = '';
  }

  loadMetadata() {
    if (!this.selectedSourceObject || !this.selectedTargetObject) {
      this.isLoading = false;
      this.cdr.detectChanges();
      return;
    }

    this.isLoading = true;
    this.cdr.detectChanges(); 

    forkJoin({
      sourceData: this.mappingApi.getFields(this.sourceCrmId, this.selectedSourceObject),
      targetData: this.mappingApi.getFields(this.targetCrmId, this.selectedTargetObject)
    }).subscribe({
      next: ({ sourceData, targetData }) => {
        this.targetFields = targetData.fields || [];
        this.sourceFields = sourceData.fields || [];

        this.previewHeaders = sourceData.headers || [];
        this.previewRecords = sourceData.sampleRecords || [];

        this.mappings = (sourceData.fields || []).map((field: FieldMeta) => ({
          sourceField: field.name,
          // NEW: Embed the API Name into the Source Label dynamically
          sourceLabel: field.label,
          targetField: ''
        }));

        this.updateMappedCount();
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Metadata payload extraction failed:', err);
        this.logMessages.unshift(`API Error: Unable to fetch live dataset metrics from ${this.sourceSystem}.`);
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  clearMapping(index: number) {
    this.mappings[index].targetField = '';
    this.updateMappedCount();
  }

  resetAllMappings() {
    this.mappings.forEach((m) => (m.targetField = ''));
    this.updateMappedCount();
  }

  autoMap() {
    let matchCount = 0;

    this.mappings.forEach((m) => {
      if (m.targetField) return;

      const sourceMeta = this.sourceFields.find(sf => sf.name === m.sourceField);
      if (!sourceMeta) return;

      const srcApiExact = sourceMeta.name.toLowerCase();
      const srcLabelExact = sourceMeta.label.toLowerCase();
      
      const srcApiClean = srcApiExact.replace(/[^a-z0-9]/g, '');
      const srcLabelClean = srcLabelExact.replace(/[^a-z0-9]/g, '');

      let match = null;

      // PASS 1: Exact API Name Match
      match = this.targetFields.find(t => t.name.toLowerCase() === srcApiExact);
      // PASS 2: Exact UI Label Match
      if (!match) match = this.targetFields.find(t => t.label.toLowerCase() === srcLabelExact);
      // PASS 3: Fuzzy API Name Match
      if (!match) match = this.targetFields.find(t => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === srcApiClean);
      // PASS 4: Fuzzy UI Label Match
      if (!match) match = this.targetFields.find(t => t.label.toLowerCase().replace(/[^a-z0-9]/g, '') === srcLabelClean);
      // PASS 5: Aggressive Substring Match 
      if (!match && srcApiClean.length > 3) {
         match = this.targetFields.find(t => {
           const tgtApiClean = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
           return tgtApiClean.includes(srcApiClean) || srcApiClean.includes(tgtApiClean);
         });
      }

      // --- STRICT MAPPING CHECK ---
      if (this.isStrictMapping && match) {
        const sType = sourceMeta.type;
        const tType = match.type;
        const isCompatible = sType === tType || (sType === 'string' && ['string', 'picklist', 'reference'].includes(tType || ''));
        
        if (!isCompatible) {
          match = null; // Reject the match because data types do not align
        }
      }

      // Apply the match if found
      if (match) {
        m.targetField = match.name;
        if (this.isReferenceField(match.name)) {
          m.relationalExtIdField = 'Id';
        }
        matchCount++;
      }
    });

    this.updateMappedCount();
    
    if (matchCount > 0) {
      this.logMessages.unshift(`System: Auto-mapping applied. ${matchCount} fields mapped.`);
    } else {
      this.logMessages.unshift(`System: Auto-mapping ran, but no new matching fields were found.`);
    }
  }

  updateMappedCount() {
    this.mappedCount = this.mappings.filter((m) => m.targetField !== '').length;
  }

  async validateData() {
    if (this.previewRecords.length === 0) {
      this.logError('❌ Validation Aborted: No data available to validate. Please fetch data first.');
      return;
    }

    if (this.mappedCount === 0) {
      this.logError('❌ Validation Aborted: You must map at least one field to validate data.');
      return;
    }

    this.jobStatus = 'Validating...';
    this.logMessages = [...this.logMessages, `System: Sending ${this.previewRecords.length} sample records to validation engine...`];
    this.cdr.detectChanges();

    const activeMappings = this.mappings
      .filter(m => m.targetField)
      .map(m => ({
        csvField: m.sourceField,
        sfField: m.targetField,
        type: this.targetFields.find(t => t.name === m.targetField)?.type || 'string'
      }));

    const sfRules: any = {};
    this.targetFields.forEach(field => {
      sfRules[field.name] = field;
    });

    const payload = {
      records: this.previewRecords,
      mappings: activeMappings,
      dedupeKey: this.externalIdField,
      sfRules: sfRules
    };
    try {
      this.isValidating = true; 
      const response = await fetch('http://localhost:8000/api/python/revalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error("Validation engine failed to respond.");

      const result = await response.json();
      
      this.validationResults = result;
      this.aggregateStats = result.stats;
      this.errorCurrentPage = 1;

      this.logMessages = [...this.logMessages, `✅ Validation Complete: ${result.stats.valid} Valid, ${result.stats.invalid} Invalid, ${result.stats.duplicates} Duplicates.`];
      this.jobStatus = result.stats.invalid > 0 ? 'Validation Warning' : 'Validation Passed';

    } catch (error) {
      console.error('Validation Error:', error);
      this.logError('❌ System Error: Could not reach validation engine.');
      this.jobStatus = 'Validation Failed';
    } finally {
      this.isValidating = false;
      this.cdr.detectChanges();
      setTimeout(() => this.scrollToBottom(), 10);
    }
  }

  hasErrorsInColumn(sourceField: string): boolean {
    if (!this.validationResults?.invalidRecords) return false;
    const searchStr = `[${sourceField}:`;
    return this.validationResults.invalidRecords.some((record: any) => record.errors.includes(searchStr));
  }

  hasCellError(record: any, sourceField: string): boolean {
    if (!record || !record.errors) return false;
    const searchStr = `[${sourceField}:`;
    return record.errors.includes(searchStr);
  }

  markAsEdited(record: any, fieldName: string) {
    if (!record._editedFields) record._editedFields = {};
    record._editedFields[fieldName] = true;
  }

  async revalidatePreview() {
    if (!this.validationResults?.invalidRecords?.length) return;
    const recordsToTest = this.validationResults.invalidRecords.map((ir: any) => ir.originalRow);
    this.previewRecords = recordsToTest; 
    await this.validateData(); 
  }




  downloadCSV(data: any[], filename: string) {
    if (!data || data.length === 0) return;

    const headers = Object.keys(data[0]);
    const csvRows = [];
    
    csvRows.push(headers.join(','));

    for (const row of data) {
      const values = headers.map(header => {
        const val = row[header];
        const escaped = ('' + (val || '')).replace(/"/g, '""');
        return `"${escaped}"`;
      });
      csvRows.push(values.join(','));
    }

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    a.setAttribute('download', filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  runMigration() {
    this.successData = [];
    this.errorData = [];
    this.jobStatus = 'Initializing...';
    this.logMessages = [];
    this.cdr.detectChanges();

    if (this.customQuery && !this.validateQuery()) {
      this.jobStatus = 'Validation Failed';
      this.cdr.detectChanges();
      return;
    }

    // Auto queue if they haven't manually queued it but clicked run
    if (this.migrationQueue.length === 0 && this.selectedTargetObject && this.mappedCount > 0) {
      this.queueAnotherObject();
    }

    if (this.migrationQueue.length === 0) {
      this.jobStatus = 'Failed';
      this.logError('❌ Error: The migration queue is empty.');
      this.cdr.detectChanges();
      return;
    }

    // Send the entire queue array
    const payload = { queue: this.migrationQueue };

    const ws = new WebSocket('ws://localhost:8000/ws/migrate');

    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      this.zone.run(() => {
        const data = JSON.parse(event.data);

        if (data.log) {
          this.logMessages = [...this.logMessages, data.log];
        }
        
        if (data.status) {
          this.jobStatus = data.status;
        }

        if (data.successData) this.successData = data.successData;
        if (data.errorData) this.errorData = data.errorData;

        this.cdr.detectChanges();

        setTimeout(() => {
          const logContainer = document.querySelector('.bg-dark.overflow-auto, .shadow-inner');
          if (logContainer) {
            logContainer.scrollTop = logContainer.scrollHeight;
          }
        }, 10);
      });
    };

    ws.onerror = (error) => {
      this.zone.run(() => {
        this.logMessages.push('FATAL: Connection to migration engine lost or refused.');
        this.jobStatus = 'Failed';
        this.cdr.detectChanges();
      });
    };

    ws.onclose = () => {
      this.zone.run(() => {
        if (this.jobStatus === 'Running' || this.jobStatus === 'Initializing...') {
          this.jobStatus = 'Disconnected';
        }
        this.cdr.detectChanges();
      });
    };
  }
}