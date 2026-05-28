import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, ChangeDetectorRef, NgZone, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from 'src/app/theme/shared/components/breadcrumbs/breadcrumbs.component';
import { MappingApiService } from 'src/app/services/mapping-api.service';
import { ToastrService } from 'ngx-toastr';
import Swal from 'sweetalert2';

interface FieldMeta {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  isRequired?: boolean;
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
  massUpdateValue?: string;
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
  private toastr = inject(ToastrService);

  // CRM Identifiers from previous step
  sourceCrmId: string = '';
  targetCrmId: string = '';
  sourceSystem = 'Unknown';
  targetSystem = 'Unknown';
  currentSessionId: string = '';

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
  isHistoryDropdownOpen = false;
  
  operationMode: string = 'insert';
  batchSize: number = 5000;
  
  recentQueries: string[] = [];

  ngOnInit(): void {
    this.sourceSystem = localStorage.getItem('source_crm_slot') || 'Zendesk';
    this.targetSystem = localStorage.getItem('target_crm_slot') || 'Salesforce';

    const navState = history.state;
    this.sourceCrmId = navState?.sourceCrm || localStorage.getItem('source_crm_slot') || 'msdynamics';
    this.targetCrmId = navState?.targetCrm || localStorage.getItem('target_crm_slot') || 'salesforce';

    this.recentQueries = JSON.parse(localStorage.getItem('crm_query_history') || '[]');

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
    this.isHistoryDropdownOpen = false;
  }

  buildDefaultQuery(entityName: string) {
    const crm = this.sourceCrmId.toLowerCase();
    
    if (crm === 'zendesk') {
      let singularName = entityName.toLowerCase();
      if (singularName.endsWith('s') && singularName !== 'macros') {
        singularName = singularName.slice(0, -1);
      }
      this.customQuery = `type:${singularName} `; 
      
    } else if (crm === 'salesforce' || crm === 'zoho') {
      this.customQuery = `SELECT * FROM ${entityName}`; 
      
    } else {
      this.customQuery = `SELECT * FROM ${entityName} WHERE `;
    }
  }

  toggleHistoryDropdown(event: Event) {
    event.stopPropagation();
    const wasOpen = this.isHistoryDropdownOpen;
    this.closeAllDropdowns();
    this.isHistoryDropdownOpen = !wasOpen;
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

    if (fieldMeta.type === 'reference' || (fieldMeta.referenceTo && fieldMeta.referenceTo.length > 0)) {
      return true;
    }

    if (fieldName !== 'Id' && fieldName.endsWith('Id')) {
      return true;
    }

    return false;
  }

  getMissingRequiredFields(): string[] {
    if (this.operationMode === 'delete') return [];
    if (!this.targetFields || this.targetFields.length === 0) return [];

    const requiredFields = this.targetFields
      .filter(f => f.isRequired || f.required)
      .map(f => f.name);

    const mappedFields = this.mappings
      .filter(m => m.targetField !== '')
      .map(m => m.targetField);

    return requiredFields.filter(reqField => !mappedFields.includes(reqField));
  }

  getIncompleteReferenceMappings(): string[] {
    const incomplete: string[] = [];
    this.mappings.forEach(m => {
      if (m.targetField && this.isReferenceField(m.targetField) && !m.relationalExtIdField) {
        incomplete.push(m.targetField);
      }
    });
    return incomplete;
  }

  selectField(mapping: any, fieldName: string) {
    mapping.targetField = fieldName;
    mapping.isDropdownOpen = false;
    
    if (this.isReferenceField(fieldName)) {
      mapping.relationalExtIdField = 'Id';
    } else {
      mapping.relationalExtIdField = undefined; 
    }
    
    this.updateMappedCount();
  }

  getFilteredTargetFields(query: string | undefined, sourceFieldName: string): any[] {
    let filtered = this.targetFields;

    if (this.isStrictMapping) {
      const sourceMeta = this.sourceFields.find(f => f.name === sourceFieldName);
      
      if (sourceMeta && sourceMeta.type) {
        filtered = filtered.filter(t => {
          if (sourceMeta.type === 'string' && ['string', 'picklist', 'reference'].includes(t.type || '')) {
            return true;
          }
          return t.type === sourceMeta.type;
        });
      }
    }

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

    const crm = this.sourceCrmId.toLowerCase();
    
    if (crm === 'zendesk') {
      let singularName = entityName.toLowerCase();
      if (singularName.endsWith('s') && singularName !== 'macros') {
        singularName = singularName.slice(0, -1);
      }
      this.customQuery = `type:${singularName} `; 
      
    } else if (crm === 'salesforce') {
      this.customQuery = `SELECT * FROM ${entityName}`; 
      
    } else {
      this.customQuery = `SELECT * FROM ${entityName} WHERE `;
    }

    this.buildDefaultQuery(entityName);

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
    return entity ? `${entity.label} (${entity.name})` : entityName;
  }

  getTargetObjectLabel(objName: string): string {
    if (!objName) return '';
    const obj = this.targetEntities.find(e => e.name === objName);
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
    } else if (crm === 'zoho') {
      return {
        title: 'Zoho COQL Filter',
        placeholder: "e.g., Account_Name != null and Industry = 'Technology'",
        helpText: "Enter Zoho criteria or a COQL condition to filter your records.",
        icon: 'icon-filter',
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
      return; 
    }

    this.isPreviewLoading = true;
    this.previewRecords = [];
    this.cdr.detectChanges(); 
    this.saveQueryToHistory(this.customQuery);

    let safeQuery = this.customQuery.trim();
    if (this.sourceCrmId.toLowerCase() === 'salesforce' && safeQuery.toLowerCase().startsWith('select ')) {
      const whereMatch = safeQuery.match(/where\s+(.*)/i);
      safeQuery = whereMatch ? whereMatch[1].trim() : '';
    }

    const payload = {
      crmId: this.sourceCrmId,
      objectName: this.selectedSourceObject,
      query: safeQuery, // Sent as safeQuery
      headers: this.previewHeaders,
      sfToken: localStorage.getItem('sf_token') || '',
      sfInstance: localStorage.getItem('sf_instance_url') || '',
      zdToken: localStorage.getItem('zd_token') || '',
      zdSubdomain: localStorage.getItem('zd_subdomain') || '',
      zohoToken: localStorage.getItem('zoho_token') || '',
      zohoDomain: localStorage.getItem('zoho_api_domain') || ''
    };

    try {
      const response = await fetch('http://localhost:8000/api/metadata/preview-filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // --- DETAILED ERROR LOGGING EXTRACTED FROM BACKEND ---
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: "Unknown Server Error" }));
        throw new Error(errorData.detail || "Failed to fetch filtered data.");
      }
      
      const data = await response.json();
      this.previewRecords = data.records || [];
      this.logMessages = [...this.logMessages, `System: Source preview updated using filter -> [${this.customQuery}]`];

    } catch (error: any) {
      console.error('Filter Error:', error);
      this.previewRecords = [];
      // --- LOGS EXACT ERROR FROM PYTHON STRAIGHT TO TERMINAL ---
      this.logMessages = [...this.logMessages, ` API Error: ${error.message}`];
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

  validateQuery(): boolean {
    this.queryError = null; 
    if (!this.customQuery) return true;

    const queryLower = this.customQuery.trim().toLowerCase();
    const crm = this.sourceCrmId.toLowerCase();

    // 1. CRM-Specific Syntax Rules
    if (crm === 'zendesk') {
      if (queryLower.startsWith('select ') || queryLower.includes(' from ') || queryLower.includes(' where ')) {
        this.queryError = "Zendesk doesn't support SQL. Format: type:ticket status<solved";
      } else if (queryLower.includes(',')) {
        this.queryError = "Do not use commas. Format: status:open tags:urgent";
      } else if (queryLower.includes(' = ')) {
        this.queryError = "Use colons for exact matches. Format: status:open";
      } else if (queryLower.includes('%')) {
        this.queryError = "Use '*' for wildcards. Format: name:tech*";
      } else if (queryLower.includes('!=') || queryLower.includes('<>')) {
        this.queryError = "Use '-' to exclude a value. Format: -status:closed";
      }
    } else if (crm === 'salesforce' || crm === 'zoho') {
      if (queryLower.includes('limit ') || queryLower.includes('order by ')) {
        this.queryError = "Do not use LIMIT or ORDER BY. The engine handles pagination automatically.";
      } else if (queryLower.endsWith(';')) {
        this.queryError = "Do not end your query with a semicolon (;).";
      }

      if (queryLower.startsWith('select ') && queryLower.includes(' from ')) {
        const fromParts = queryLower.split(' from ');
        const objPart = fromParts[1].split(' ')[0].trim();
        if (objPart && objPart.toLowerCase() !== this.selectedSourceObject.toLowerCase()) {
          this.queryError = `Object Mismatch: You selected '${this.selectedSourceObject}', but your query says FROM '${objPart}'.`;
          return false;
        }
      }
    }

    // 2. Field Schema Verification
    if (!this.queryError && this.sourceFields.length > 0) {
      let extractedConditions: { field: string, value: string }[] = [];

      if (crm === 'zendesk') {
        const zendeskRegex = /(-)?([a-zA-Z0-9_]+)[:<>]([a-zA-Z0-9_*-]+)/g;
        let match;
        const ignoreList = ['type', 'tags', 'order_by', 'sort', 'created', 'updated']; 
        
        while ((match = zendeskRegex.exec(this.customQuery)) !== null) {
          if (!ignoreList.includes(match[2].toLowerCase())) {
            extractedConditions.push({ field: match[2].toLowerCase(), value: match[3] });
          }
        }
      } else if (crm === 'salesforce' || crm === 'zoho') {
        // Shared Regex for SOQL and COQL
        const sqlRegex = /\b([a-zA-Z0-9_]+)\s*(?:=|!=|<|>|<=|>=|like|is)\s*('?[a-zA-Z0-9_%\s-]+'?|null)/gi;
        let match;
        const reservedWords = ['select', 'from', 'where', 'and', 'or', 'null', 'is', 'like', 'not'];
        
        while ((match = sqlRegex.exec(this.customQuery)) !== null) {
          const fieldName = match[1].toLowerCase();
          if (reservedWords.includes(fieldName)) continue;

          extractedConditions.push({ 
            field: fieldName, 
            value: match[2].replace(/'/g, '').trim()
          });
        }
      }

      for (const condition of extractedConditions) {
        const schemaField = this.sourceFields.find(f => f.name.toLowerCase() === condition.field);
        
        if (!schemaField) {
          this.queryError = `Invalid Field: '${condition.field}' does not exist on ${this.selectedSourceObject}.`;
          break; 
        }

        const val = condition.value || '';
        const type = schemaField.type?.toLowerCase() || 'string';

        if (val.includes('*') || val.includes('%') || val.toLowerCase() === 'null') continue;

        if (['number', 'currency', 'double', 'int'].includes(type) && isNaN(Number(val))) {
          this.queryError = `Type Mismatch: '${condition.field}' is a Number, but you entered text ('${val}').`;
          break;
        }

        if (type === 'boolean' && !['true', 'false', '1', '0'].includes(val.toLowerCase())) {
          this.queryError = `Type Mismatch: '${condition.field}' is a Boolean (True/False). You entered '${val}'.`;
          break;
        }

        if (['date', 'datetime'].includes(type) && isNaN(Date.parse(val))) {
          const sfDateLiterals = ['today', 'yesterday', 'tomorrow', 'this_week', 'last_week', 'this_month'];
          if (crm === 'salesforce' && sfDateLiterals.includes(val.toLowerCase())) continue;
          
          this.queryError = `Type Mismatch: '${condition.field}' requires a valid date format. You entered '${val}'.`;
          break;
        }
      }
    }

    return this.queryError === null; 
  }

  loadHistoricalQuery(query: string) {
    this.customQuery = query;
    this.isHistoryDropdownOpen = false;
    this.validateQuery();
  }

  saveQueryToHistory(query: string) {
    if (!query) return;
    this.recentQueries = this.recentQueries.filter(q => q !== query);
    this.recentQueries.unshift(query);
    if (this.recentQueries.length > 5) this.recentQueries.pop();
    
    localStorage.setItem('crm_query_history', JSON.stringify(this.recentQueries));
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
            (e) => e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('ticket') || e.name.toLowerCase().includes('contacts')
          );
          this.selectedSourceObject = defaultSrc ? defaultSrc.name : this.sourceEntities[0].name;
          
          this.buildDefaultQuery(this.selectedSourceObject);
        }

        if (this.targetEntities.length > 0) {
          const defaultTgt = this.targetEntities.find(
            (e) => e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('user') || e.name.toLowerCase().includes('contacts')
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
          sourceLabel: `${field.label} (${field.name})`, 
          targetField: ''
        }));

        this.updateMappedCount();
        this.isLoading = false;
        this.cdr.detectChanges();

        if (this.customQuery && this.previewHeaders.length > 0) {
           this.applyFilter();
        }
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

      match = this.targetFields.find(t => t.name.toLowerCase() === srcApiExact);
      if (!match) match = this.targetFields.find(t => t.label.toLowerCase() === srcLabelExact);
      if (!match) match = this.targetFields.find(t => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === srcApiClean);
      if (!match) match = this.targetFields.find(t => t.label.toLowerCase().replace(/[^a-z0-9]/g, '') === srcLabelClean);
      if (!match && srcApiClean.length > 3) {
         match = this.targetFields.find(t => {
           const tgtApiClean = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
           return tgtApiClean.includes(srcApiClean) || srcApiClean.includes(tgtApiClean);
         });
      }

      if (this.isStrictMapping && match) {
        const sType = sourceMeta.type;
        const tType = match.type;
        const isCompatible = sType === tType || (sType === 'string' && ['string', 'picklist', 'reference'].includes(tType || ''));
        
        if (!isCompatible) {
          match = null; 
        }
      }

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
    this.cdr.detectChanges();
  }

  async validateData(isRevalidation: boolean = false, fixedRecords: any[] = []) {
    if (this.mappedCount === 0) {
      this.toastr.error('Validation Aborted: You must map at least one field to validate data.');
      return;
    }

    // Only show the big popup and wipe stats if it is a FRESH run
    if (!isRevalidation) {
      const confirmResult = await Swal.fire({
        title: 'Validate Entire Database?',
        text: `This will securely stream and test ALL live records from ${this.selectedSourceObject} in chunks. It can safely handle millions of rows without crashing your browser.`,
        icon: 'info',
        showCancelButton: true,
        confirmButtonColor: '#0d6efd',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Yes, Start Validation Stream'
      });

      if (!confirmResult.isConfirmed) return;

      this.jobStatus = 'Connecting...';
      this.logMessages = [];
      this.aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
      this.validationResults = { invalidRecords: [] };
      this.currentSessionId = ''; 
    } else {
      this.jobStatus = 'Re-validating...';
      this.toastr.info('Checking fixed records against Salesforce rules...', 'Re-validating');
    }

    this.isValidating = true;
    this.errorCurrentPage = 1;
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

    let safeQuery = this.customQuery.trim();
    const crmContext = this.sourceCrmId.toLowerCase();
    if ((crmContext === 'salesforce' || crmContext === 'zoho') && safeQuery.toLowerCase().startsWith('select ')) {
      const whereMatch = safeQuery.match(/where\s+(.*)/i);
      safeQuery = whereMatch ? whereMatch[1].trim() : '';
    }

    // Inject the Revalidation flags into the payload
    const payload = {
      isRevalidation: isRevalidation,        // <--- NEW
      sessionId: this.currentSessionId,      // <--- NEW
      fixedRecords: fixedRecords,            // <--- NEW
      crmId: this.sourceCrmId,
      objectName: this.selectedSourceObject,
      query: safeQuery,
      mappings: activeMappings,
      dedupeKey: this.externalIdField,
      sfRules: sfRules,
      sfToken: localStorage.getItem('sf_token') || '',
      sfInstance: localStorage.getItem('sf_instance_url') || '',
      zdToken: localStorage.getItem('zd_token') || '',
      zdSubdomain: localStorage.getItem('zd_subdomain') || '',
      zohoToken: localStorage.getItem('zoho_token') || '',
      zohoDomain: localStorage.getItem('zoho_api_domain') || ''
    };
    
    // Connect to the new streaming websocket
    const ws = new WebSocket('ws://localhost:8000/ws/validate-stream');

    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      this.zone.run(() => {
        const data = JSON.parse(event.data);
        
        if (data.log) {
          // Keep only the last 50 logs to prevent UI lag on massive streams
          this.logMessages.push(data.log);
          if (this.logMessages.length > 50) this.logMessages.shift();
        }

        if (data.status) {
          this.jobStatus = data.status;
        }

        // --- LIVE STAT UPDATES ---
        if (data.stats) {
          this.aggregateStats = data.stats;
        }

        // --- FINAL RESULTS INJECTION ---
        if ((data.status === 'Validation Passed' || data.status === 'Validation Warning') && data.invalidRecords) {
           this.validationResults.invalidRecords = data.invalidRecords;
           if (data.sessionId) {
             this.currentSessionId = data.sessionId; // Save the session!
           }
           
           if (data.invalidRecords.length >= 500) {
             this.toastr.warning('Showing the first 500 errors to prevent browser lag.', 'Max Errors Reached');
           }
           this.isValidating = false;
        }

        this.cdr.detectChanges();
        setTimeout(() => this.scrollToBottom(), 10);
      });
    };

    ws.onerror = () => {
      this.zone.run(() => {
        this.logError(' WebSocket Error: Validation stream disconnected.');
        this.jobStatus = 'Validation Failed';
        this.isValidating = false;
        this.cdr.detectChanges();
      });
    };

    ws.onclose = () => {
      this.zone.run(() => {
        if (this.jobStatus !== 'Validation Passed' && this.jobStatus !== 'Validation Warning' && this.jobStatus !== 'Validation Failed') {
           this.jobStatus = 'Disconnected';
        }
        this.isValidating = false;
        this.cdr.detectChanges();
      });
    };
  }

  applyMassUpdate(sourceField: string, value: string | undefined) {
    if (value === undefined) value = '';
    
    // Check if there are actually records to update
    if (!this.validationResults || !this.validationResults.invalidRecords || this.validationResults.invalidRecords.length === 0) {
      return;
    }

    let updatedCount = 0;

    // Loop through ALL error records, but ONLY apply the fix if that specific cell failed!
    this.validationResults.invalidRecords.forEach((record: any) => {
      if (this.hasCellError(record, sourceField)) {
        record.originalRow[sourceField] = value;
        this.markAsEdited(record, sourceField);
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      this.toastr.success(`Updated '${sourceField}' across ${updatedCount} records. Correct data was left untouched!`, 'Mass Update Applied');
    } else {
      this.toastr.info(`No records had an error in '${sourceField}', so nothing was changed.`, 'No Updates Needed');
    }

    this.cdr.detectChanges();
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
    
    // Grab all the rows currently in the error grid (including the user's edits)
    const recordsToTest = this.validationResults.invalidRecords.map((ir: any) => ir.originalRow);
    
    // Pass True to trigger the shortcut in Python
    await this.validateData(true, recordsToTest); 
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
    if (this.customQuery && !this.validateQuery()) {
      this.jobStatus = 'Validation Failed';
      this.toastr.error('Please fix your query criteria before running.', 'Query Error');
      return;
    }

    const activeMappings = this.mappings.filter(m => m.targetField !== '');

    if (activeMappings.length === 0) {
      this.jobStatus = 'Failed';
      this.toastr.warning('Please map at least one field before running the migration.', 'No Mappings');
      return;
    }

    if (!this.selectedSourceObject || !this.selectedTargetObject) {
      this.jobStatus = 'Failed';
      this.toastr.error('Source and Target objects must be selected.', 'Missing Setup');
      return;
    }

    const missingFields = this.getMissingRequiredFields();
    const incompleteRefs = this.getIncompleteReferenceMappings();

    if (missingFields.length > 0 || incompleteRefs.length > 0) {
      let warningHtml = '<div class="text-start mt-2">';
      
      if (missingFields.length > 0) {
        warningHtml += `<p class="text-danger fw-bold mb-1"><i class="feather icon-alert-triangle"></i> Missing Required Fields:</p>
                        <ul class="small mb-3 text-muted"><li>${missingFields.join('</li><li>')}</li></ul>`;
      }
      
      if (incompleteRefs.length > 0) {
        warningHtml += `<p class="text-warning text-dark fw-bold mb-1"><i class="feather icon-link"></i> Incomplete Lookups:</p>
                        <p class="small mb-1 text-muted">You mapped these relational fields but left the <strong>Parent Ext ID</strong> blank (It will default to 'Id'):</p>
                        <ul class="small mb-0 text-muted"><li>${incompleteRefs.join('</li><li>')}</li></ul>`;
      }
      warningHtml += '</div>';

      Swal.fire({
        title: 'Mapping Warnings',
        html: warningHtml,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Run Anyway',
        cancelButtonText: 'Fix Mapping',
        confirmButtonColor: '#dc3545',
        customClass: { popup: 'rounded-4 shadow-lg border-0' }
      }).then((result) => {
        if (result.isConfirmed) {
          this.executeMigrationJob(activeMappings);
        } else {
          this.jobStatus = 'Idle';
        }
      });
    } else {
      // If validation passes perfectly, run it directly
      Swal.fire({
        title: 'Ready to Migrate!',
        text: `Are you sure you want to execute this ${this.operationMode.toUpperCase()} job? This will push live data into ${this.selectedTargetObject}.`,
        icon: 'info',
        showCancelButton: true,
        confirmButtonColor: '#198754', // Green button for go
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Yes, Run Job!'
      }).then((result) => {
        if (result.isConfirmed) {
          this.executeMigrationJob(activeMappings);
        } else {
          this.jobStatus = 'Idle';
        }
      });
    }
  }

  // --- Separated execution logic for clean popup handling ---
  private executeMigrationJob(activeMappings: any[]) {
    this.successData = [];
    this.errorData = [];
    this.jobStatus = 'Initializing...';
    this.logMessages = [];
    this.cdr.detectChanges();
    this.toastr.info('Connecting to Migration Engine...', 'Job Started');

    const enhancedMappings = activeMappings.map(m => {
      const fieldMeta = this.targetFields.find(t => t.name === m.targetField);
      const isRef = this.isReferenceField(m.targetField);
      return {
        sourceField: m.sourceField,
        targetField: m.targetField,
        type: isRef ? 'reference' : fieldMeta?.type,
        referenceTo: fieldMeta?.referenceTo,
        relationshipName: fieldMeta?.relationshipName,
        relationalExtIdField: m.relationalExtIdField || (isRef ? 'Id' : undefined), 
        parentObjectName: m.parentObjectName || (fieldMeta?.referenceTo ? fieldMeta.referenceTo[0] : undefined)
      };
    });

    let safeQuery = this.customQuery.trim();
    if (this.sourceCrmId.toLowerCase() === 'salesforce' && safeQuery.toLowerCase().startsWith('select ')) {
      const whereMatch = safeQuery.match(/where\s+(.*)/i);
      safeQuery = whereMatch ? whereMatch[1].trim() : '';
    }

    const fixedRecords = this.validationResults?.invalidRecords
      ?.filter((rec: any) => rec._editedFields) // Only grab rows the user actually touched
      ?.map((rec: any) => rec.originalRow) || [];

    const job = {
      sessionId: this.currentSessionId,
      fixedRecords: fixedRecords,
      sourceObject: this.selectedSourceObject,
      targetObject: this.selectedTargetObject,
      extractionQuery: safeQuery,
      mappings: enhancedMappings,
      operationMode: this.operationMode,
      batchSize: this.batchSize,
      externalIdField: this.externalIdField,
      
      sfToken: localStorage.getItem('sf_token') || '',
      sfInstance: localStorage.getItem('sf_instance_url') || '',
      zdToken: localStorage.getItem('zd_token') || '',
      zdSubdomain: localStorage.getItem('zd_subdomain') || '',
      zohoToken: localStorage.getItem('zoho_token') || '',
      zohoDomain: localStorage.getItem('zoho_api_domain') || ''
    };

    const payload = { queue: [job] };
    const ws = new WebSocket('ws://localhost:8000/ws/migrate');

    ws.onopen = () => { ws.send(JSON.stringify(payload)); };

    ws.onmessage = (event) => {
      this.zone.run(() => {
        const data = JSON.parse(event.data);
        if (data.log) this.logMessages = [...this.logMessages, data.log];
        if (data.status) {
          this.jobStatus = data.status;
          if (data.status === 'Finished') {
             this.toastr.success('Migration process has finished.', 'Job Complete');
          }
        }
        if (data.successData) this.successData = data.successData;
        if (data.errorData) this.errorData = data.errorData;

        this.cdr.detectChanges();
        setTimeout(() => {
          const logContainer = document.querySelector('.bg-dark.overflow-auto, .shadow-inner');
          if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
        }, 10);
      });
    };

    ws.onerror = () => {
      this.zone.run(() => {
        this.logMessages.push('FATAL: Connection to migration engine lost or refused.');
        this.jobStatus = 'Failed';
        this.toastr.error('WebSocket connection failed.', 'Engine Error');
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