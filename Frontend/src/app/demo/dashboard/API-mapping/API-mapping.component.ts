import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, ChangeDetectorRef, NgZone, HostListener, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MappingApiService } from 'src/app/services/mapping-api.service';
import { ToastrService } from 'ngx-toastr';
import Swal from 'sweetalert2';
import { EditorComponent } from 'ngx-monaco-editor-v2';
import { environment } from 'src/environments/environment';
import { HttpClient } from '@angular/common/http';
import { AuthService } from 'src/app/demo/Services/auth.service';
declare const monaco: any;
interface FieldMeta {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  isRequired?: boolean;
  referenceTo?: string[];
  relationshipName?: string;
  externalId?: boolean;
  unique?: boolean;
  idLookup?: boolean;
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
  _isAiProcessing?: boolean;
  _mappedBy?: 'rule' | 'ai';
}

interface CrmEntity {
  name: string;
  label: string;
}

@Component({
  selector: 'app-api-mapping',
  standalone: true,
  imports: [CommonModule, FormsModule, EditorComponent],
  templateUrl: './API-mapping.component.html',
  styleUrls: ['./API-mapping.component.scss']
})
export class ApiMappingComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private mappingApi = inject(MappingApiService);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  private toastr = inject(ToastrService);
  private authService = inject(AuthService);
  private validationSocket: WebSocket | null = null;
  private migrationSocket: WebSocket | null = null;
  private http = inject(HttpClient);

  private mappingCancel$ = new Subject<void>();
  private lastLoadedTargetObject: string | null = null;
  private isStandardZendeskObject(name: string): boolean {
    if (!name) return false;
    const std = ['tickets', 'users', 'organizations', 'groups', 'macros', 'triggers', 'views'];
    const safeName = name.toLowerCase();
    return std.includes(safeName) || std.includes(safeName + 's');
  }
  // --- ADD THIS HELPER METHOD ---
  private flattenObject(ob: any): any {
    const result: any = {};
    for (const i in ob) {
      if (!ob.hasOwnProperty(i)) continue;

      if (typeof ob[i] === 'object' && ob[i] !== null && !Array.isArray(ob[i])) {
        const flatObject = this.flattenObject(ob[i]);
        for (const x in flatObject) {
          if (!flatObject.hasOwnProperty(x)) continue;
          result[x] = flatObject[x];
        }
      } else {
        result[i] = ob[i];
      }
    }
    return result;
  }

  isGlobalLoading: boolean = false;
  globalLoadingText: string = 'Loading...';
  globalLoadingSubText: string = 'Please wait...';
  // CRM Identifiers from previous step
  sourceCrmId: string = '';
  targetCrmId: string = '';
  sourceSystem = 'Unknown';
  targetSystem = 'Unknown';
  currentSessionId: string = '';
  previewLimit: number = 5;
  isAutoMapping: boolean = false;
  autoMapProgress = { current: 0, total: 0 };

  // Dynamic Entity Lists for Dropdowns
  sourceEntities: CrmEntity[] = [];
  targetEntities: CrmEntity[] = [];
  showReviewPanel: boolean = false;
  reviewPanelMinimized: boolean = false;
  reviewFilter: 'mapped' | 'unmapped' = 'mapped';

  readonly reviewPanelDefaultWidth = 1000;
  readonly reviewPanelDefaultHeight = 680;
  reviewPanelTop = 100;
  reviewPanelLeft = 100;
  private reviewPanelDragging = false;
  private reviewPanelDragOffset = { x: 0, y: 0 };

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
  hideMappedFields = false;
  selectedSourceObjectCount: number | null = null;
  isSourceCountLoading = false;
  restrictMappingToQueryFields = true;

  currentUser: any = null;
isProfileDropdownOpen = false;

  // Execution Variables
  jobStatus = 'Idle';
  logMessages: string[] = [];
  customQuery: string = '';
  isDefaultQuery: boolean = true;
  queryError: string | null = null;
  isPreviewLoading = false;
  sourceFields: FieldMeta[] = [];
  successData: any[] = [];
  isQueueMinimized: boolean = false;
  errorData: any[] = [];
  skippedData: any[] = [];
  aggregateStats = { total: 0, valid: 0, invalid: 0, duplicates: 0 };
  validationResults: any = null;
  isValidating = false;
  errorCurrentPage: number = 1;
  errorPageSize: number = 10;
  mappingSearchQuery = '';
  reviewPanelExpanded: boolean = false;
  isSourceDropdownOpen = false;
  sourceSearchQuery = '';
  isTargetDropdownOpen = false;
  targetSearchQuery = '';
  isHistoryDropdownOpen = false;
  isMigrationFilterOpen = false;

  operationMode: string = 'insert';
  batchSize: number = 5000;
  migrationQueue: any[] = [];

  // Files & Attachments (Salesforce -> Salesforce only)
  migrateAttachments = false;
  migrateFiles = false;

  get isSalesforceToSalesforce(): boolean {
    return this.sourceCrmId?.toLowerCase() === 'salesforce' && this.targetCrmId?.toLowerCase() === 'salesforce';
  }

  recentQueries: string[] = [];
  // --- MONACO EDITOR CONFIGURATION ---
  editorOptions = {
    theme: 'vs', // Use 'vs-dark' if you want a dark code editor!
    language: 'sql', // Highlights SELECT, WHERE, AND, OR automatically
    minimap: { enabled: false }, // Hides the code minimap on the right
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    lineNumbers: 'off',
    renderLineHighlight: 'none',
    fontSize: 13,
    padding: { top: 10, bottom: 10 },
    suggestOnTriggerCharacters: true
  };

  monacoEditorInstance: any;
  completionProvider: any;

  recoverableSessions: any[] = [];
  isSessionsLoading = false;

  ngOnInit(): void {
    this.getUserData();
// this.fetchRecoverableSessions();
// this.preloadEntirePage();
    const navState = history.state;
    this.sourceCrmId = navState?.sourceCrm || localStorage.getItem('source_crm_slot');
    this.targetCrmId = navState?.targetCrm || localStorage.getItem('target_crm_slot');

    if (!this.sourceCrmId || !this.targetCrmId) {
      this.toastr.warning('Please connect your Source and Target systems first.', 'Connections Required');
      this.router.navigate(['/connection']);
      return;
    }

    this.sourceSystem = this.sourceCrmId;
    this.targetSystem = this.targetCrmId;
    this.migrationTimeFilter.field = this.timeFilterFieldOptions[0]?.value || '';
    this.batchSize = this.batchConfig.default;

    localStorage.setItem('source_crm_slot', this.sourceCrmId);
    localStorage.setItem('target_crm_slot', this.targetCrmId);

    this.recentQueries = JSON.parse(localStorage.getItem('crm_query_history') || '[]');

    this.fetchRecoverableSessions();

    this.preloadEntirePage();
  }

  ngOnDestroy() {
    this.mappingCancel$.next();
    this.mappingCancel$.complete();

    // 1. Kill active websockets
    this.closeSocket(this.validationSocket);
    this.closeSocket(this.migrationSocket);
    this.validationSocket = null;
    this.migrationSocket = null;

    if (this.monacoEditorInstance) {
      this.monacoEditorInstance.dispose();
    }
  }

  private closeSocket(socket: WebSocket | null): void {
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  fetchRecoverableSessions() {
    this.isSessionsLoading = true;
    fetch(`${environment.apiUrl}/api/validation/sessions`)
      .then((res) => res.json())
      .then((data) => {
        this.recoverableSessions = data.sessions || [];
        this.isSessionsLoading = false;
        this.cdr.detectChanges();
      })
      .catch(() => (this.isSessionsLoading = false));
  }

  resumeSession(sessionId: string, crm: string, object: string) {
    this.currentSessionId = sessionId;
    this.sourceCrmId = crm.toLowerCase();
    this.selectedSourceObject = object.toLowerCase();

    this.toastr.info(`Restoring previous session...`, 'Resuming');
    this.validateData(true, []);
  }

  validateBatchSize() {
    const config = this.batchConfig;
    if (this.batchSize > config.max) {
      this.batchSize = config.max;
      this.toastr.info(`Batch size reduced to ${config.max} to comply with ${this.targetSystem} API limits.`);
    } else if (this.batchSize < config.min) {
      this.batchSize = config.min;
    }
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
        return { min: 100, max: 10000, step: 100, default: 5000, tooltip: 'Salesforce max limit: 10,000' };
    }
  }

  getQuerySelectedFields(): string[] | null {
    const crm = (this.sourceCrmId || '').toLowerCase();
    const query = (this.customQuery || '').trim();
    if (!query) return null;

    switch (crm) {
      case 'salesforce':
      case 'zoho':
        return this.parseSqlStyleSelectedFields(query);
      case 'hubspot':
        return this.parseHubspotSelectedFields(query);
      case 'zendesk':
        return this.parseZendeskSelectedFields(query);
      default:
        return null;
    }
  }

  private parseSqlStyleSelectedFields(query: string): string[] | null {
    const queryLower = query.toLowerCase();
    if (!queryLower.startsWith('select ')) return null;

    const fromIdx = queryLower.indexOf(' from ');
    if (fromIdx === -1) return null;

    const selectClause = query.substring(7, fromIdx).trim();
    if (selectClause === '*') return null;

    const fields = selectClause
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .map((f) => f.split('.')[0]);

    return fields.length > 0 ? fields : null;
  }

  private parseHubspotSelectedFields(query: string): string[] | null {
    let parsed: any;
    try {
      parsed = JSON.parse(query.replace(/\/\*[\s\S]*?\*\//g, '').trim());
    } catch {
      return null; 
    }

    const properties = parsed?.properties;
    if (!Array.isArray(properties) || properties.length === 0) return null;

    const fields = properties.map((p: any) => String(p).trim()).filter((p: string) => p.length > 0);
    return fields.length > 0 ? fields : null;
  }

  private parseZendeskSelectedFields(query: string): string[] | null {
    if (!this.selectedSourceObject || this.isStandardZendeskObject(this.selectedSourceObject)) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(query.replace(/\/\*[\s\S]*?\*\//g, '').trim());
    } catch {
      return null;
    }

    const fields = parsed?.fields;
    if (!Array.isArray(fields) || fields.length === 0) return null;

    const cleaned = fields.map((f: any) => String(f).trim()).filter((f: string) => f.length > 0);
    return cleaned.length > 0 ? cleaned : null;
  }

migrationTimeFilter = {
  field: '',
  startDate: '' as string, // ISO yyyy-MM-dd
  endDate: '' as string,   // ISO yyyy-MM-dd
  utcOffsetMinutes: -new Date().getTimezoneOffset()
};

dateRangeError: string | null = null;

get timeFilterFieldOptions(): { value: string; label: string }[] {
  const crm = this.sourceSystem?.toLowerCase();
  if (crm === 'zoho') {
    return [
      { value: 'Modified_Time', label: 'Last Modified' },
      { value: 'Created_Time', label: 'Created' }
    ];
  }
  if (crm === 'zendesk') {
    return [
      { value: 'updated', label: 'Last Updated' },
      { value: 'created', label: 'Created' }
    ];
  }
  if (crm === 'hubspot') {
    return [
      { value: 'hs_lastmodifieddate', label: 'Last Modified' },
      { value: 'createdate', label: 'Created' }
    ];
  }
  return [
    { value: 'LastModifiedDate', label: 'Last Modified' },
    { value: 'CreatedDate', label: 'Created' }
  ];
}

get todayIsoDate(): string {
  return new Date().toISOString().split('T')[0];
}

get migrationFilterSummary(): string {
  const f = this.migrationTimeFilter;
  if (f.startDate && f.endDate) {
    return `${f.startDate} → ${f.endDate}`;
  }
  if (f.startDate) {
    return `${f.startDate} → today`;
  }
  return 'No Filter';
}

get isMigrationFilterActive(): boolean {
  return !!this.migrationTimeFilter.startDate;
}

triggerLivePreview(): void {
  if (!this.validateDateRange()) return;
  this.applyFilter();
}

validateDateRange(): boolean {
  this.dateRangeError = null;
  const { startDate, endDate } = this.migrationTimeFilter;

  if (!startDate && !endDate) return true;

  if (endDate && !startDate) {
    this.dateRangeError = "Please select a 'From' date as well — an end date on its own isn't enough to filter by.";
    return false;
  }

  const start = new Date(startDate);
  if (isNaN(start.getTime())) {
    this.dateRangeError = 'Please enter a valid start date.';
    return false;
  }

  if (!endDate) {
    return true;
  }

  const end = new Date(endDate);
  if (isNaN(end.getTime())) {
    this.dateRangeError = 'Please enter a valid end date.';
    return false;
  }

  if (start > end) {
    this.dateRangeError = 'Start date must be on or before the end date.';
    return false;
  }

  if (end > new Date(this.todayIsoDate)) {
    this.dateRangeError = 'End date cannot be in the future.';
    return false;
  }

  return true;
}

onDateRangeChange(): void {
  this.activeQuickRangePreset = null;
  this.triggerLivePreview();
}

clearDateRange(): void {
  this.migrationTimeFilter.startDate = '';
  this.migrationTimeFilter.endDate = '';
  this.activeQuickRangePreset = null;
  this.dateRangeError = null;
  this.applyFilter();
}

activeQuickRangePreset: string | null = null;

readonly quickRangePresets: { key: string; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: 'thisMonth', label: 'This Month' },
  { key: 'lastMonth', label: 'Last Month' }
];

applyQuickRange(preset: string): void {
  const end = new Date();
  let start = new Date();

  switch (preset) {
    case 'today':
      start = new Date();
      break;
    case '7d':
      start.setDate(end.getDate() - 6);
      break;
    case '30d':
      start.setDate(end.getDate() - 29);
      break;
    case 'thisMonth':
      start = new Date(end.getFullYear(), end.getMonth(), 1);
      break;
    case 'lastMonth': {
      const lastMonthStart = new Date(end.getFullYear(), end.getMonth() - 1, 1);
      const lastMonthEnd = new Date(end.getFullYear(), end.getMonth(), 0);
      this.setDateRange(lastMonthStart, lastMonthEnd, preset);
      return;
    }
    default:
      return;
  }

  this.setDateRange(start, end, preset);
}

private setDateRange(start: Date, end: Date, preset: string): void {
  this.migrationTimeFilter.startDate = this.toIsoDate(start);
  this.migrationTimeFilter.endDate = this.toIsoDate(end);
  this.activeQuickRangePreset = preset;
  this.dateRangeError = null;
  this.triggerLivePreview();
}

private toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

private getFilterSuffix(): string {
  const f = this.migrationTimeFilter;
  if (f.startDate && f.endDate) {
    return ` (filtered: ${f.startDate} to ${f.endDate})`;
  }
  if (f.startDate) {
    return ` (filtered: ${f.startDate} to today)`;
  }
  return '';
}

get isEligibleForTimeFilter(): boolean {
  const crm = this.sourceSystem?.toLowerCase();
  return crm === 'salesforce' || crm === 'zoho' || crm === 'zendesk' || crm === 'hubspot';
}

  onQueryEdited() {
    this.queryError = null;
    this.isDefaultQuery = false;
  }

  private getQueryFieldFilterSet(): Set<string> | null {
    if (!this.restrictMappingToQueryFields) return null;
    const querySelectedFields = this.getQuerySelectedFields();
    if (!querySelectedFields) return null;
    return new Set(querySelectedFields.map((f) => f.toLowerCase()));
  }

  private restrictToQueryFields<T extends { sourceField: string }>(rows: T[]): T[] {
    const fieldSet = this.getQueryFieldFilterSet();
    if (!fieldSet) return rows;
    return rows.filter((r) => fieldSet.has((r.sourceField || '').toLowerCase()));
  }

  get visibleMappings() {
    let filtered = this.mappings;

    const queryFieldSet = this.getQueryFieldFilterSet();
    if (queryFieldSet) {
      filtered = filtered.filter(
        (m) =>
          queryFieldSet.has((m.sourceField || '').toLowerCase()) ||
          !!m.targetField 
      );
    }

    if (this.hideMappedFields) {
      filtered = filtered.filter((m) => !m.targetField);
    }

    if (this.mappingSearchQuery) {
      const query = this.mappingSearchQuery.toLowerCase().trim();
      filtered = filtered.filter(
        (m) =>
          (m.sourceLabel && m.sourceLabel.toLowerCase().includes(query)) || (m.sourceField && m.sourceField.toLowerCase().includes(query))
      );
    }

    return filtered;
  }

  get isQueryFieldFilterActive(): boolean {
    return this.getQueryFieldFilterSet() !== null;
  }

  get queryFilteredFieldCount(): number {
    return this.getQuerySelectedFields()?.length ?? 0;
  }

  private getLiveRecordHeaders(): string[] {
    if (!this.previewRecords || this.previewRecords.length === 0) return [];
    const headerSet = new Set<string>();
    const sampleSize = Math.min(this.previewRecords.length, 25); 
    for (let i = 0; i < sampleSize; i++) {
      Object.keys(this.previewRecords[i] || {}).forEach((k) => headerSet.add(k));
    }
    return Array.from(headerSet);
  }

  get visiblePreviewHeaders(): string[] {
    const liveHeaders = this.getLiveRecordHeaders();
    const baseHeaders = liveHeaders.length > 0 ? liveHeaders : this.previewHeaders;

    const fieldSet = this.getQueryFieldFilterSet();
    if (!fieldSet) return baseHeaders;

    const narrowed = baseHeaders.filter((h) => fieldSet.has(h.toLowerCase()));
    return narrowed.length > 0 ? narrowed : baseHeaders;
  }

  getUserData(): void {
  const storedUser = localStorage.getItem('supabase_user');
  if (!storedUser) {
    this.currentUser = null;
    return;
  }
  try {
    this.currentUser = JSON.parse(storedUser);
  } catch (error) {
    console.error('Failed to parse user data from local storage', error);
    this.currentUser = null;
  }
}

toggleProfileDropdown(event: Event): void {
  event.stopPropagation();
  const wasOpen = this.isProfileDropdownOpen;
  this.closeAllDropdowns();
  this.isProfileDropdownOpen = !wasOpen;
}

  changePreviewLimit(newLimit: number) {

    this.previewLimit = Number(newLimit);

    if (this.selectedSourceObject) {
      this.applyFilter();
    }
  }

  getFieldMeta(fieldName: string, side: 'source' | 'target'): FieldMeta | undefined {
    return side === 'source' ? this.sourceFields.find((f) => f.name === fieldName) : this.targetFields.find((f) => f.name === fieldName);
  }

  getFieldTypeBadge(type: string | undefined): string {
    if (!type) return 'bg-secondary';
    const t = type.toLowerCase();
    if (t.includes('string') || t.includes('text') || t.includes('email')) return 'bg-info text-dark';
    if (t.includes('number') || t.includes('int') || t.includes('double') || t.includes('currency')) return 'bg-success';
    if (t.includes('boolean')) return 'bg-warning text-dark';
    if (t.includes('reference') || t.includes('lookup')) return 'bg-primary';
    if (t.includes('date') || t.includes('time')) return 'bg-danger';
    if (t.includes('picklist')) return 'bg-secondary';
    return 'bg-secondary';
  }

  get hasPendingEdits(): boolean {
    if (!this.validationResults?.invalidRecords) return false;

  
    return this.validationResults.invalidRecords.some((rec: any) => rec._editedFields && Object.keys(rec._editedFields).length > 0);
  }

  isTypeMismatch(mapping: any): boolean {
    if (!mapping.targetField) return false;
    const srcType = this.getFieldMeta(mapping.sourceField, 'source')?.type?.toLowerCase() || 'string';
    const tgtType = this.getFieldMeta(mapping.targetField, 'target')?.type?.toLowerCase() || 'string';

    if (srcType === 'id' || tgtType === 'id') return false;

    if (srcType === tgtType) return false;

    if (srcType.includes('string') && ['string', 'text', 'textarea', 'picklist', 'reference'].includes(tgtType)) return false;
  
    if (['number', 'integer', 'double', 'currency'].includes(srcType) && ['number', 'integer', 'double', 'currency'].includes(tgtType))
      return false;

    return true;
  }

  onEditorInit(editor: any) {
    this.monacoEditorInstance = editor;

    if (!this.completionProvider) {
      // ==========================================
      //  DYNAMIC AUTOCOMPLETE
      // ==========================================
      this.completionProvider = monaco.languages.registerCompletionItemProvider('sql', {
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          };

          const suggestions: any[] = [];
          const crm = this.sourceCrmId.toLowerCase();

          // ------------------------------------
          //  ZENDESK MODE
          // ------------------------------------
          if (crm === 'zendesk') {
            // --- Context-Aware Value Suggestions ---
            const lineContent = model.getLineContent(position.lineNumber);
            const textBeforeCursor = lineContent.substring(0, position.column - 1);

            // 1. If typing a Status
            if (textBeforeCursor.match(/\bstatus:[a-zA-Z]*$/)) {
              const statuses = ['new', 'open', 'pending', 'hold', 'solved', 'closed'];
              statuses.forEach((s) =>
                suggestions.push({
                  label: s,
                  kind: monaco.languages.CompletionItemKind.EnumMember,
                  insertText: s + ' ',
                  range: range,
                  detail: 'Zendesk Ticket Status'
                })
              );
              return { suggestions: suggestions };
            }

            // 2. If typing a Priority
            if (textBeforeCursor.match(/\bpriority:[a-zA-Z]*$/)) {
              const priorities = ['low', 'normal', 'high', 'urgent'];
              priorities.forEach((p) =>
                suggestions.push({
                  label: p,
                  kind: monaco.languages.CompletionItemKind.EnumMember,
                  insertText: p + ' ',
                  range: range,
                  detail: 'Zendesk Ticket Priority'
                })
              );
              return { suggestions: suggestions };
            }

            // 3. If typing a Type
            if (textBeforeCursor.match(/\btype:[a-zA-Z]*$/)) {
              const types = ['ticket', 'user', 'organization', 'group'];
              types.forEach((t) =>
                suggestions.push({
                  label: t,
                  kind: monaco.languages.CompletionItemKind.EnumMember,
                  insertText: t + ' ',
                  range: range,
                  detail: 'Zendesk Record Type'
                })
              );
              return { suggestions: suggestions };
            }

            // --- STANDARD ZENDESK SUGGESTIONS ---

            // 4. Zendesk Smart Snippet
            suggestions.push({
              label: 'Active Tickets (Snippet)',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: `type:ticket status<solved `,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Auto-generates a search for all unresolved tickets.',
              range: range
            });

            // 5. Zendesk Keywords
            const zdKeywords = [
              'type:',
              'status:',
              'priority:',
              'tags:',
              'assignee:',
              'requester:',
              'group:',
              'created>',
              'updated>',
              'order_by:',
              'sort:'
            ];
            zdKeywords.forEach((kw) => {
              suggestions.push({
                label: kw,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: kw,
                range: range
              });
            });

            // 6. Zendesk CRM Fields
            if (this.sourceFields && this.sourceFields.length > 0) {
              this.sourceFields.forEach((field) => {
                suggestions.push({
                  label: field.name,
                  detail: `${field.label} (${field.type})`,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: field.name + ':',
                  range: range
                });
              });
            }
          } else if (crm === 'hubspot') {
            suggestions.push({
              label: 'Basic Filter (Snippet)',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: `{\n  "filterGroups": [\n    {\n      "filters": [\n        {\n          "propertyName": "email",\n          "operator": "EQ",\n          "value": ""\n        }\n      ]\n    }\n  ]\n}`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Auto-generates a basic HubSpot JSON filter block.',
              range: range
            });

            const hsOperators = [
              'EQ',
              'NEQ',
              'LT',
              'LTE',
              'GT',
              'GTE',
              'BETWEEN',
              'IN',
              'NOT_IN',
              'HAS_PROPERTY',
              'NOT_HAS_PROPERTY',
              'CONTAINS_TOKEN',
              'NOT_CONTAINS_TOKEN'
            ];
            hsOperators.forEach((op) => {
              suggestions.push({
                label: op,
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: `"${op}"`,
                range: range
              });
            });
          }
          // ------------------------------------
          //  SALESFORCE & ZOHO (SQL) MODE
          // ------------------------------------
          else {
            const snippetFields =
              this.sourceFields && this.sourceFields.length > 0
                ? this.sourceFields.slice(0, 15).map((f) => f.name).join(', ')
                : 'Id';

            suggestions.push({
              label: 'SELECT (Basic)',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: `SELECT ${snippetFields} FROM ${this.selectedSourceObject || 'Object'} WHERE `,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Auto-generates a SELECT query using real field names for the current object.',
              range: range
            });

            const sqlKeywords = [
              'SELECT',
              'FROM',
              'WHERE',
              'AND',
              'OR',
              'LIKE',
              'LIMIT',
              'ORDER BY',
              'ASC',
              'DESC',
              'NULL',
              'IS',
              'NOT',
              'IN'
            ];
            sqlKeywords.forEach((kw) => {
              suggestions.push({
                label: kw,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: kw + ' ',
                range: range
              });
            });

            if (this.sourceFields && this.sourceFields.length > 0) {
              this.sourceFields.forEach((field) => {
                suggestions.push({
                  label: field.name,
                  detail: `${field.label} (${field.type})`,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: field.name,
                  range: range
                });
              });
            }
          }

          return { suggestions: suggestions };
        }
      });

      // ==========================================
      //  SMART HOVER TOOLTIPS
      // ==========================================
      monaco.languages.registerHoverProvider('sql', {
        provideHover: (model: any, position: any) => {
          const wordInfo = model.getWordAtPosition(position);
          if (!wordInfo) return null;

          const cleanWord = wordInfo.word.replace(/[:<>]/g, '').toLowerCase();

          const field = this.sourceFields.find((f) => f.name.toLowerCase() === cleanWord);

          if (field) {
            return {
              range: new monaco.Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn),
              contents: [
                { value: `**${field.label}**` },
                { value: `API Name: \`${field.name}\`` },
                { value: `Type: **${field.type || 'String'}** | Required: **${field.isRequired || field.required ? 'Yes' : 'No'}**` }
              ]
            };
          }
          return null;
        }
      });
    }
  }


  injectFieldAtCursor(fieldName: string) {
    if (this.monacoEditorInstance) {
      const position = this.monacoEditorInstance.getPosition();

      this.monacoEditorInstance.executeEdits('custom-inject', [
        {
          range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          text: fieldName + ' ',
          forceMoveMarkers: true
        }
      ]);

      this.monacoEditorInstance.focus();
      this.customQuery = this.monacoEditorInstance.getValue();
    } else {
      if (!this.customQuery) {
        this.customQuery = fieldName;
      } else {
        this.customQuery += ` ${fieldName}`;
      }
    }
    this.validateQuery();
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
  this.mappings.forEach((m) => (m.isDropdownOpen = false));
  this.isSourceDropdownOpen = false;
  this.isTargetDropdownOpen = false;
  this.isHistoryDropdownOpen = false;
  this.isProfileDropdownOpen = false;
  this.isMigrationFilterOpen = false;
}

toggleMigrationFilterDropdown(event: Event) {
  event.stopPropagation();
  const wasOpen = this.isMigrationFilterOpen;
  this.closeAllDropdowns();
  this.isMigrationFilterOpen = !wasOpen;
}

onRestrictToQueryFieldsChange(): void {
  if (!this.restrictMappingToQueryFields && this.isEligibleForTimeFilter) {
    this.isMigrationFilterOpen = true;
  }
}


openReviewPanel(): void {
  this.reviewPanelExpanded = false;
  this.reviewPanelMinimized = false;
  this.reviewPanelLeft = Math.max(20, (window.innerWidth - this.reviewPanelDefaultWidth) / 2);
  this.reviewPanelTop = Math.max(20, (window.innerHeight - this.reviewPanelDefaultHeight) / 2);
  this.showReviewPanel = true;
}

startReviewPanelDrag(event: MouseEvent): void {
  if (this.reviewPanelExpanded) return;
  if ((event.target as HTMLElement).closest('button')) return;

  const panelEl = (event.currentTarget as HTMLElement).closest('.floating-review-panel') as HTMLElement;
  if (!panelEl) return;

  const rect = panelEl.getBoundingClientRect();
  this.reviewPanelDragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  this.reviewPanelDragging = true;
  event.preventDefault();
}

@HostListener('document:mousemove', ['$event'])
onReviewPanelDrag(event: MouseEvent): void {
  if (!this.reviewPanelDragging) return;

  // Keep at least a corner of the header reachable so a panel dragged to
  // the edge can always be dragged back, instead of getting stuck off-screen.
  const margin = 60;
  const maxLeft = window.innerWidth - margin;
  const maxTop = window.innerHeight - margin;

  this.reviewPanelLeft = Math.min(Math.max(event.clientX - this.reviewPanelDragOffset.x, 0), maxLeft);
  this.reviewPanelTop = Math.min(Math.max(event.clientY - this.reviewPanelDragOffset.y, 0), maxTop);
}

@HostListener('document:mouseup')
onReviewPanelDragEnd(): void {
  this.reviewPanelDragging = false;
}

  // --- ADD THIS TEMPLATE CONSTANT ---
  readonly ZENDESK_CUSTOM_OBJECT_TEMPLATE = `/* Zendesk Custom Object Query Template 
 - Leave blank to fetch all records.
 - Prefix custom fields with 'custom_object_fields.' 
 - Optional: add a top-level "fields": ["field_a", "field_b"] array to restrict
   which fields appear in the mapping table and get migrated (same role as a
   SOQL/COQL SELECT list). Omit it to keep the full object schema mappable.
*/
{
  "filter": {
    "$and": [
      { "custom_object_fields.your_field_key": { "$eq": "Your Value" } }
    ]
  }
}`;

  readonly HUBSPOT_SEARCH_TEMPLATE = `/* HubSpot Search Filter 
 - Leave blank to fetch all records.
 - Uses HubSpot's JSON Search syntax.
 - Optional: add a top-level "properties": ["field_a", "field_b"] array to
   restrict which fields HubSpot returns and which appear in the mapping table
   (same role as a SOQL/COQL SELECT list). Omit it to keep the full schema.
*/
{
  "filterGroups": [
    {
      "filters": [
        {
          "propertyName": "email",
          "operator": "EQ",
          "value": "test@domain.com"
        }
      ]
    }
  ]
}`;

  buildDefaultQuery(entityName: string) {
    const crm = this.sourceCrmId.toLowerCase();
    this.isDefaultQuery = true;

    if (crm === 'zendesk') {
      if (this.isStandardZendeskObject(entityName)) {
        let singularName = entityName.toLowerCase();
        if (singularName.endsWith('s') && singularName !== 'macros') {
          singularName = singularName.slice(0, -1);
        }
        this.customQuery = `type:${singularName} `;
      } else {
        this.customQuery = this.ZENDESK_CUSTOM_OBJECT_TEMPLATE;
      }
    } else if (crm === 'hubspot') {
      this.customQuery = this.HUBSPOT_SEARCH_TEMPLATE;
    } else if (crm === 'salesforce') {
      this.customQuery = `SELECT Id FROM ${entityName}`;
    } else if (crm === 'zoho') {
      this.customQuery = `SELECT id FROM ${entityName}`;
    } else {
      this.customQuery = `SELECT Id FROM ${entityName} WHERE `;
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
    const fieldMeta = this.targetFields.find((f) => f.name === fieldName);

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

    const requiredFields = this.targetFields.filter((f) => f.isRequired || f.required).map((f) => f.name);

    const mappedFields = this.mappings.filter((m) => m.targetField !== '').map((m) => m.targetField);

    return requiredFields.filter((reqField) => !mappedFields.includes(reqField));
  }

  getIncompleteReferenceMappings(): string[] {
    const incomplete: string[] = [];
    this.mappings.forEach((m) => {
      if (m.targetField && this.isReferenceField(m.targetField) && !m.relationalExtIdField) {
        incomplete.push(m.targetField);
      }
    });
    return incomplete;
  }

  selectField(mapping: any, fieldName: string) {
    mapping.targetField = fieldName;
    mapping.isDropdownOpen = false;
    delete mapping._mappedBy;

    if (this.isReferenceField(fieldName)) {
      mapping.relationalExtIdField = 'Id';
    } else {
      mapping.relationalExtIdField = undefined;
    }

    this.updateMappedCount();
  }

  hasActiveTypeMismatches(): boolean {
    return this.mappings.some((mapping) => mapping.targetField && this.isTypeMismatch(mapping));
  }

  getFilteredTargetFields(query: string | undefined, sourceFieldName: string): any[] {
    const claimedByOtherRows = new Set(
      this.mappings.filter((m) => m.sourceField !== sourceFieldName && m.targetField).map((m) => m.targetField)
    );
    let filtered = this.targetFields.filter((t) => !claimedByOtherRows.has(t.name));

    if (this.isStrictMapping) {
      const sourceMeta = this.sourceFields.find((f) => f.name === sourceFieldName);

      if (sourceMeta && sourceMeta.type) {
        filtered = filtered.filter((t) => {
          if (sourceMeta.type === 'string' && ['string', 'picklist', 'reference'].includes(t.type || '')) {
            return true;
          }
          return t.type === sourceMeta.type;
        });
      }
    }

    if (query) {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter((f) => f.label.toLowerCase().includes(lowerQuery) || f.name.toLowerCase().includes(lowerQuery));
    }

    return filtered;
  }

  getTargetFieldLabel(fieldName: string): string {
    if (!fieldName) return '';
    const field = this.targetFields.find((f) => f.name === fieldName);
    return field ? `${field.label} (${field.name})` : fieldName;
  }

  isExternalIdEligible(field: FieldMeta): boolean {
    const crm = (this.targetCrmId || '').toLowerCase();
    if (crm === 'zoho') {
      return field.name === 'id' || !!field.unique || !!field.externalId;
    }
    if (crm === 'hubspot') {
      return field.name === 'id' || field.name === 'hs_object_id' || !!field.unique || !!field.externalId;
    }
    if (crm === 'zendesk') {
      return !!field.externalId;
    }
    return field.name === 'Id' || !!field.externalId || !!field.idLookup;
  }

  getExternalIdEligibleFields(): FieldMeta[] {
    if (!this.targetFields) return [];
    return this.targetFields.filter((f) => this.isExternalIdEligible(f));
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

    this.buildDefaultQuery(entityName);
    this.loadSourceObjectCount(entityName);

    this.loadMetadata();
  }

  selectTargetObject(objName: string) {
    this.selectedTargetObject = objName;
    this.isTargetDropdownOpen = false;
    this.loadMetadata();
  }

  private rankEntityMatches(entities: any[], query: string): any[] {
    const q = query.trim().toLowerCase();
    if (!q) return entities;

    const rank = (e: any): number => {
      const name = (e.name || '').toLowerCase();
      const label = (e.label || '').toLowerCase();
      if (name === q || label === q) return 0;
      if (name.startsWith(q) || label.startsWith(q)) return 1;
      return 2;
    };

    return entities
      .filter((e) => (e.label || '').toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || (a.label || '').localeCompare(b.label || ''));
  }

  getFilteredSourceEntities(): any[] {
    if (!this.sourceSearchQuery) return this.sourceEntities;
    return this.rankEntityMatches(this.sourceEntities, this.sourceSearchQuery);
  }

  getFilteredTargetEntities(): any[] {
    if (!this.targetSearchQuery) return this.targetEntities;
    return this.rankEntityMatches(this.targetEntities, this.targetSearchQuery);
  }

  getSourceEntityLabel(entityName: string): string {
    if (!entityName) return '';
    const entity = this.sourceEntities.find((e) => e.name === entityName);
    return entity ? `${entity.label} (${entity.name})` : entityName;
  }

  getTargetObjectLabel(objName: string): string {
    if (!objName) return '';
    const obj = this.targetEntities.find((e) => e.name === objName);
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
      const isCustom = this.selectedSourceObject && !this.isStandardZendeskObject(this.selectedSourceObject);

      return {
        title: isCustom ? 'Zendesk Custom Object Filter' : 'Zendesk Search Filter',
        placeholder: isCustom
          ? '{\n  "filter": {\n    "$and": [\n      { "custom_object_fields.your_field": { "$eq": "value" } }\n    ]\n  }\n}'
          : 'e.g., type:ticket status<solved created>2023-01-01',
        helpText: isCustom
          ? "Use JSON. Prefix custom fields with 'custom_object_fields.'. Leave blank for all records. Add a top-level \"fields\": [...] array to restrict which fields are mappable."
          : 'Use Zendesk native search syntax to filter by tags, status, or dates.',
        icon: 'icon-search',
        buttonText: 'Apply Filter',
        loadingText: 'Filtering...'
      };
    } else if (crm === 'hubspot') {
      return {
        title: 'HubSpot Search Filter',
        placeholder:
          '{\n  "filterGroups": [\n    {\n      "filters": [\n        { "propertyName": "hs_object_id", "operator": "GT", "value": "0" }\n      ]\n    }\n  ]\n}',
        helpText: 'Use HubSpot JSON search syntax to filter records. Leave blank to fetch all. Add a top-level "properties": [...] array to restrict which fields are returned and mappable.',
        icon: 'icon-filter',
        buttonText: 'Apply Filter',
        loadingText: 'Filtering...'
      };
       } else if (crm === 'salesforce') {
      return {
        title: 'SOQL Query Editor',
        placeholder: 'e.g., SELECT Id, Name FROM Account WHERE Amount > 5000 LIMIT 100',
        helpText: 'Write your full SOQL query to filter data, or append LIMIT to restrict the migration size.',
        icon: 'icon-database',
        buttonText: 'Run Query',
        loadingText: 'Querying...'
      };
    } else if (crm === 'zoho') {
      return {
        title: 'Zoho COQL Editor',
        placeholder: "e.g., SELECT id, Account_Name FROM Accounts WHERE Industry = 'Technology' LIMIT 200",
        helpText: "Write your full COQL query. The engine automatically handles Zoho's strict ID rules behind the scenes.",
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

    if (!this.validateDateRange()) {
      return;
    }

    if (!this.validateQuery()) {
      return;
    }

    this.isPreviewLoading = true;
    this.previewRecords = [];
    this.cdr.detectChanges();
    this.saveQueryToHistory(this.customQuery);

    let safeQuery = this.customQuery.trim();

    if (this.sourceCrmId.toLowerCase() === 'zendesk' && !this.isStandardZendeskObject(this.selectedSourceObject)) {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();

      const cleanBlankTemplate = this.ZENDESK_CUSTOM_OBJECT_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = '';
      }
    }

    if (this.sourceCrmId.toLowerCase() === 'hubspot') {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const cleanBlankTemplate = this.HUBSPOT_SEARCH_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = '';
      }
    }

    const payload = {
      crmId: this.sourceCrmId,
      objectName: this.selectedSourceObject,
      query: safeQuery,
      headers: this.previewHeaders,
      limit: this.previewLimit,
      authToken: localStorage.getItem('supabase_token') || '',
      migrationTimeFilter: this.migrationTimeFilter
    };

    try {
      const response = await fetch(`${environment.apiUrl}/api/metadata/preview-filter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('supabase_token') || ''}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown Server Error' }));
        throw new Error(errorData.detail || 'Failed to fetch filtered data.');
      }

      const data = await response.json();
      this.previewRecords = data.records || [];
      this.loadSourceObjectCount(this.selectedSourceObject, safeQuery, this.migrationTimeFilter);
      const filterSuffix = this.getFilterSuffix();
      const executedQuery = data.queryUsed || this.customQuery || 'default query';
      this.logMessages = [...this.logMessages, `System: Source preview updated${filterSuffix} -> [${executedQuery}]`];
    } catch (error: any) {
      console.error('Filter Error:', error);
      this.previewRecords = [];

      const errorMessage = error.message || 'Invalid Query Syntax rejected by CRM.';
      this.queryError = `API Error: ${errorMessage}`;

      this.toastr.error('Your query was rejected by the source CRM.', 'Query Error');
      this.logMessages = [...this.logMessages, ` API Error: ${errorMessage}`];
    } finally {
      this.isPreviewLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadSourceObjectCount(objectName: string, query: string = '', timeFilter: { field: string; startDate: string; endDate: string; utcOffsetMinutes: number } | null = null) {
    if (!objectName || !this.sourceCrmId) {
      this.selectedSourceObjectCount = null;
      return;
    }

    this.isSourceCountLoading = true;
    this.cdr.detectChanges();

    try {
      const params = new URLSearchParams({ role: 'source' });
      if (query) params.set('query', query);
      if (timeFilter && timeFilter.startDate) {
        params.set('timeFilter', JSON.stringify(timeFilter));
      }

      const response = await fetch(
        `${environment.apiUrl}/api/metadata/${this.sourceCrmId}/count/${encodeURIComponent(objectName)}?${params.toString()}`,
        { headers: { Authorization: `Bearer ${localStorage.getItem('supabase_token') || ''}` } }
      );

      if (!response.ok) throw new Error('Failed to fetch object count.');

      const data = await response.json();
      this.selectedSourceObjectCount = typeof data.count === 'number' ? data.count : null;
    } catch (error) {
      console.error('Object Count Error:', error);
      this.selectedSourceObjectCount = null;
    } finally {
      this.isSourceCountLoading = false;
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

    if (this.monacoEditorInstance) {
      monaco.editor.setModelMarkers(this.monacoEditorInstance.getModel(), 'sql-validation', []);
    }

    if (!this.customQuery) return true;

    const queryLower = this.customQuery.trim().toLowerCase();
    const crm = this.sourceCrmId.toLowerCase();


    const applySquiggle = (errorMsg: string, offendingText: string): boolean => {
      this.queryError = errorMsg;

      if (this.monacoEditorInstance && offendingText) {
        const model = this.monacoEditorInstance.getModel();
        const fullText = model.getValue().toLowerCase();

        const startIndex = fullText.indexOf(offendingText.toLowerCase());

        if (startIndex !== -1) {
          const startPos = model.getPositionAt(startIndex);
          const endPos = model.getPositionAt(startIndex + offendingText.length);

          monaco.editor.setModelMarkers(model, 'sql-validation', [
            {
              startLineNumber: startPos.lineNumber,
              startColumn: startPos.column,
              endLineNumber: endPos.lineNumber,
              endColumn: endPos.column,
              message: errorMsg,
              severity: monaco.MarkerSeverity.Error
            }
          ]);
        }
      }
      return false;
    };

    // ==========================================
    // ZENDESK STRICT TOKEN VALIDATION
    // ==========================================
    if (crm === 'zendesk') {
      const isStandard = this.isStandardZendeskObject(this.selectedSourceObject);

      if (!isStandard) {
        // --- CUSTOM OBJECT VALIDATION ---
        const cleanJsonText = this.customQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();

        if (cleanJsonText === '') return true;

        // 2. Must be JSON
        if (!cleanJsonText.startsWith('{')) {
          return applySquiggle('Zendesk Custom Objects require a valid JSON filter block.', this.customQuery.trim().split(' ')[0] || ' ');
        }
        // 3. Must be VALID JSON syntax
        try {
          JSON.parse(cleanJsonText);
        } catch (e) {
          return applySquiggle('Invalid JSON Syntax. Please check your brackets, keys, and trailing commas.', '{');
        }
        return true;
      }

      // --- STANDARD OBJECT VALIDATION (Text Search) ---
      if (queryLower.startsWith('select ') || queryLower.includes(' from ')) {
        return applySquiggle("Zendesk doesn't support SQL. Format: type:ticket status<solved", 'select');
      } else if (queryLower.includes(',')) {
        return applySquiggle('Do not use commas. Format: status:open tags:urgent', ',');
      } else if (queryLower.includes(' = ')) {
        return applySquiggle('Use colons for exact matches. Format: status:open', '=');
      }

      const tokens = queryLower.split(/\s+/);
      const zendeskSystemFields = [
        'type',
        'tags',
        'status',
        'priority',
        'group_id',
        'assignee_id',
        'requester_id',
        'submitter_id',
        'organization_id',
        'created',
        'updated',
        'order_by',
        'sort'
      ];

      for (const token of tokens) {
        const match = token.match(/^(-)?([a-zA-Z0-9_]+)[:<>](.*)$/);
        if (match) {
          const fieldName = match[2];
          if (!zendeskSystemFields.includes(fieldName)) {
            const schemaField = this.sourceFields.find((f) => f.name.toLowerCase() === fieldName);
            if (!schemaField) {
              return applySquiggle(`Invalid Zendesk Field: '${fieldName}' does not exist.`, fieldName);
            }
          }
        } else if (token.length > 0 && !token.includes('*') && !token.includes('-')) {
          return applySquiggle(`Invalid Syntax: '${token}' is not formatted correctly.`, token);
        }
      }
    }

    // ==========================================
    // HUBSPOT JSON VALIDATION
    // ==========================================
    else if (crm === 'hubspot') {
      const cleanJsonText = this.customQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();

      if (cleanJsonText === '') return true; // Blank is fine (fetches all)

      if (!cleanJsonText.startsWith('{')) {
        return applySquiggle('HubSpot filters require a valid JSON block.', this.customQuery.trim().split(' ')[0] || ' ');
      }
      try {
        JSON.parse(cleanJsonText);
      } catch (e) {
        return applySquiggle('Invalid JSON Syntax. Please check your brackets, keys, and trailing commas.', '{');
      }
      return true;
    }

    // ==========================================
    //  SALESFORCE & ZOHO SQL VALIDATION
    // ==========================================
    else if (crm === 'salesforce' || crm === 'zoho') {
      if (this.customQuery.includes('"')) {
        return applySquiggle('Salesforce strictly requires single quotes (\') for text values. Do not use double quotes (").', '"');
      }

      if (queryLower.includes('order by ')) {
        return applySquiggle('Do not use ORDER BY.', 'order by');
      } else if (queryLower.endsWith(';')) {
        return applySquiggle('Do not end your query with a semicolon (;).', ';');
      }

      const hasSelect = queryLower.startsWith('select ');
      const hasWhere = queryLower.includes(' where ');
      let conditionPart = '';

      if (hasSelect) {
        if (hasWhere) {
          conditionPart = queryLower.split(' where ')[1];
        }
      } else {
        conditionPart = queryLower;
      }

      if (conditionPart.trim() !== '') {
        if (
          !conditionPart.includes('=') &&
          !conditionPart.includes('<') &&
          !conditionPart.includes('>') &&
          !conditionPart.includes('like') &&
          !conditionPart.includes(' is ')
        ) {
          return applySquiggle('Invalid Syntax: Missing SQL operators (e.g., =, <, >, LIKE).', conditionPart.trim().split(' ')[0]);
        }
      }

      if (hasSelect && queryLower.includes(' from ')) {
        const fromParts = queryLower.split(' from ');
        const objPart = fromParts[1].trim().split(' ')[0];
        if (objPart && objPart.toLowerCase() !== this.selectedSourceObject.toLowerCase()) {
          return applySquiggle(
            `Object Mismatch: You selected '${this.selectedSourceObject}', but your query says FROM '${objPart}'.`,
            objPart
          );
        }
      }

      // Deep Field & Type Validation
      const sqlRegex = /\b([a-zA-Z0-9_]+)\s*(?:=|!=|<|>|<=|>=|like|is)\s*('?[a-zA-Z0-9_%\s-]+'?|null)/gi;
      let match;
      const reservedWords = ['select', 'from', 'where', 'and', 'or', 'null', 'is', 'like', 'not'];

      while ((match = sqlRegex.exec(this.customQuery)) !== null) {
        const fieldName = match[1].toLowerCase();
        if (reservedWords.includes(fieldName)) continue;

        const schemaField = this.sourceFields.find((f) => f.name.toLowerCase() === fieldName);

        if (!schemaField) {
          return applySquiggle(`Invalid Field: '${match[1]}' does not exist on ${this.selectedSourceObject}.`, match[1]);
        }

        const val = match[2].replace(/'/g, '').trim();
        const type = schemaField.type?.toLowerCase() || 'string';

        if (val.includes('*') || val.includes('%') || val.toLowerCase() === 'null') continue;

        if (['number', 'currency', 'double', 'int'].includes(type) && isNaN(Number(val))) {
          return applySquiggle(`Type Mismatch: '${match[1]}' is a Number, but you entered text ('${val}').`, match[2]);
        }

        if (type === 'boolean' && !['true', 'false', '1', '0'].includes(val.toLowerCase())) {
          return applySquiggle(`Type Mismatch: '${match[1]}' is a Boolean. You entered '${val}'.`, match[2]);
        }
      }
    }

    return this.queryError === null;
  }

  loadHistoricalQuery(query: string) {
    this.customQuery = query;
    this.isDefaultQuery = false;
    this.isHistoryDropdownOpen = false;
    this.validateQuery();
  }

  saveQueryToHistory(query: string) {
    if (!query) return;
    this.recentQueries = this.recentQueries.filter((q) => q !== query);
    this.recentQueries.unshift(query);
    if (this.recentQueries.length > 5) this.recentQueries.pop();

    localStorage.setItem('crm_query_history', JSON.stringify(this.recentQueries));
  }

  preloadEntirePage() {
    this.isLoading = true;
    this.isGlobalLoading = true;
    this.globalLoadingText = 'Fetching Live Schemas...';
    this.globalLoadingSubText = 'Please wait while we sync the CRM engines';
    this.cdr.detectChanges();

    forkJoin({
      sourceObjs: this.mappingApi.getObjects(this.sourceCrmId, 'source'),
      targetObjs: this.mappingApi.getObjects(this.targetCrmId, 'target')
    }).subscribe({
      next: ({ sourceObjs, targetObjs }) => {
        this.sourceEntities = sourceObjs || [];
        this.targetEntities = targetObjs || [];

        if (this.sourceEntities.length > 0) {
          const defaultSrc = this.sourceEntities.find(
            (e) =>
              e.name.toLowerCase().includes('account') ||
              e.name.toLowerCase().includes('ticket') ||
              e.name.toLowerCase().includes('contacts')
          );
          this.selectedSourceObject = defaultSrc ? defaultSrc.name : this.sourceEntities[0].name;

          this.buildDefaultQuery(this.selectedSourceObject);
          this.loadSourceObjectCount(this.selectedSourceObject);
        }

        if (this.targetEntities.length > 0) {
          const defaultTgt = this.targetEntities.find(
            (e) =>
              e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('user') || e.name.toLowerCase().includes('contacts')
          );
          this.selectedTargetObject = defaultTgt ? defaultTgt.name : this.targetEntities[0].name;
        }

        this.cdr.detectChanges();
        this.loadMetadata();

        this.isGlobalLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to preload base entity dropdowns:', err);
        this.logMessages.unshift(`Configuration Error: Could not fetch core CRM schemas.`);
        this.isLoading = false;
        this.isGlobalLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  insertFieldIntoQuery(event: Event) {
    const selectElement = event.target as HTMLSelectElement;
    const fieldName = selectElement.value;

    if (!fieldName) return;

    this.injectFieldAtCursor(fieldName);

    selectElement.value = '';
  }

  loadMetadata() {
    if (!this.selectedSourceObject || !this.selectedTargetObject) {
      this.isLoading = false;
      this.cdr.detectChanges();
      return;
    }
    this.cancelPendingMappingWork();

    const targetObjectChanged = this.lastLoadedTargetObject !== this.selectedTargetObject;
    this.lastLoadedTargetObject = this.selectedTargetObject;

    this.isLoading = true;
    this.cdr.detectChanges();

    forkJoin({
      sourceData: this.mappingApi.getFields(this.sourceCrmId, this.selectedSourceObject, 'source'),
      targetData: this.mappingApi.getFields(this.targetCrmId, this.selectedTargetObject, 'target')
    })
      .pipe(takeUntil(this.mappingCancel$))
      .subscribe({
        next: ({ sourceData, targetData }) => {
          this.targetFields = targetData.fields || [];
          this.sourceFields = sourceData.fields || [];

          this.previewHeaders = sourceData.headers || [];
          this.previewRecords = sourceData.sampleRecords || [];

          const crmLower = this.sourceCrmId.toLowerCase();
          if (this.isDefaultQuery && (crmLower === 'salesforce' || crmLower === 'zoho') && this.previewHeaders.length > 0) {
            const fieldList = this.previewHeaders.slice(0, 2).join(', ');
            this.customQuery = `SELECT ${fieldList} FROM ${this.selectedSourceObject}`;
          }

          this.mappings = (sourceData.fields || []).map((field: FieldMeta) => ({
            sourceField: field.name,
            sourceLabel: `${field.label} (${field.name})`,
            targetField: ''
          }));

          this.showReviewPanel = false;
          this.reviewPanelMinimized = false;
          this.reviewFilter = 'mapped';
          this.mappingSearchQuery = '';

          if (targetObjectChanged) {
            this.externalIdField = '';
            this.validationResults = null;
          }

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

  
  private cancelPendingMappingWork(): void {
    this.mappingCancel$.next();

    this.isAutoMapping = false;
    this.autoMapProgress = { current: 0, total: 0 };
    this.mappings.forEach((m) => (m._isAiProcessing = false));
  }

  clearMapping(mapping: any) {
    mapping.targetField = '';
    mapping.relationalExtIdField = '';
    delete mapping._mappedBy;
    this.updateMappedCount();
  }

  removeMapping(mapping: any) {
    this.mappings = this.mappings.filter((m) => m !== mapping);
    this.updateMappedCount();
  }

  resetAllMappings() {
    this.mappings.forEach((m) => {
      m.targetField = '';
      m.relationalExtIdField = '';
      delete m._mappedBy;
    });

    this.updateMappedCount();
  }

  autoMap(): void {
    if (this.isAutoMapping || this.isLoading) return;

    this.isAutoMapping = true;

    let heuristicMatchCount = 0;
    const restrictedTargetFields = [
      'id',
      'hs_object_id',
      'url',
      'createddate',
      'lastmodifieddate',
      'createdbyid',
      'lastmodifiedbyid',
      'systemmodstamp',
      'isdeleted',
      'hs_createdate',
      'hs_lastmodifieddate',
      'createdate',
      'archived',
      'created_at',
      'updated_at',
      'submitter_id',
      'created_time',
      'modified_time',
      'created_by',
      'modified_by',
      '$state',
      '$process_flow',
      'createdat',
      'updatedat',
      'updateddate',
      'deleted'
    ];

    // =========================================================
    // PHASE 1: SYNCHRONOUS LOCAL TEXT MATCHING
    // =========================================================
    const claimedTargetFields = new Set<string>(this.mappings.filter((m) => m.targetField).map((m) => m.targetField));
    const queryFieldSet = this.getQueryFieldFilterSet(); 

    this.mappings.forEach((m) => {
      if (m.targetField) return;
      if (queryFieldSet && !queryFieldSet.has((m.sourceField || '').toLowerCase())) return;

      const sourceMeta = this.sourceFields.find((sf) => sf.name === m.sourceField);
      if (!sourceMeta) return;

      const srcApiExact = sourceMeta.name.toLowerCase();
      const srcLabelExact = sourceMeta.label.toLowerCase();

      const srcApiClean = srcApiExact
        .replace(/__c$/, '')
        .replace(/__r$/, '')
        .replace(/[^a-z0-9]/g, '');
      const srcLabelClean = srcLabelExact.replace(/[^a-z0-9]/g, '');
      const srcType = (sourceMeta.type || 'string').toLowerCase();

      let bestMatch: any = null;
      let highestScore = 0;

      this.targetFields.forEach((t) => {
        const tgtApiExact = t.name.toLowerCase();
        if (restrictedTargetFields.includes(tgtApiExact)) return;
        if (claimedTargetFields.has(t.name)) return;

        let score = 0;
        const tgtLabelExact = t.label.toLowerCase();

        const tgtApiClean = tgtApiExact
          .replace(/__c$/, '')
          .replace(/__r$/, '')
          .replace(/[^a-z0-9]/g, '');
        const tgtLabelClean = tgtLabelExact.replace(/[^a-z0-9]/g, '');
        const tgtType = (t.type || 'string').toLowerCase();

        if (srcType === 'reference' || tgtType === 'reference' || srcType === 'id' || tgtType === 'id') {
          return;
        }

        const isExactTypeMatch = srcType === tgtType;
        const isForgivingTypeMatch =
          (srcType.includes('string') && ['string', 'text', 'textarea', 'picklist', 'reference'].includes(tgtType)) ||
          (['number', 'integer', 'double', 'currency', 'float'].includes(srcType) &&
            ['number', 'integer', 'double', 'currency', 'float'].includes(tgtType));

        const isCompatible = isExactTypeMatch || isForgivingTypeMatch;

        if (this.isStrictMapping && !isCompatible) return;

        if (tgtApiExact === srcApiExact) score += 100;
        else if (tgtApiClean === srcApiClean) score += 90;
        else if (tgtLabelExact === srcLabelExact) score += 85;
        else if (tgtLabelClean === srcLabelClean) score += 75;
        else if (srcApiClean.length > 3 && (tgtApiClean.includes(srcApiClean) || srcApiClean.includes(tgtApiClean))) score += 40;
        else if (srcLabelClean.length > 3 && (tgtLabelClean.includes(srcLabelClean) || srcLabelClean.includes(tgtLabelClean))) score += 30;

        if (score >= 30) {
          if (isExactTypeMatch) score += 20;
          else if (isForgivingTypeMatch) score += 10;
        }

        if (score > highestScore && score >= 50) {
          highestScore = score;
          bestMatch = t;
        }
      });

      if (bestMatch) {
        m.targetField = bestMatch['name'];
        claimedTargetFields.add(bestMatch['name']);
        if (typeof this.isReferenceField === 'function' && this.isReferenceField(bestMatch['name'])) {
          m.relationalExtIdField = 'Id';
        }
        m._mappedBy = 'rule';
        heuristicMatchCount++;
      }
    });

    const unmappedSourcePayload = this.sourceFields.filter((sf) => {
      if (queryFieldSet && !queryFieldSet.has(sf.name.toLowerCase())) return false;
      const activeMap = this.mappings.find((m) => m.sourceField === sf.name);
      return activeMap && !activeMap.targetField;
    });

    if (unmappedSourcePayload.length === 0) {
      this.mappings = [...this.mappings];
      this.cdr.detectChanges();
      if (typeof this.updateMappedCount === 'function') this.updateMappedCount();

      this.isAutoMapping = false;

      if (heuristicMatchCount > 0) {
        if (this.toastr) this.toastr.success(`Intelligently aligned ${heuristicMatchCount} fields!`, 'Auto-Map Complete');
        if (this.logMessages) this.logMessages.unshift(`System: Fast-pass local mapping matched ${heuristicMatchCount} fields.`);

        this.reviewFilter = 'mapped';
        this.openReviewPanel();
      } else {
        if (this.toastr) this.toastr.info(`No matches found.`, 'Auto-Map Finished');
      }
      return;
    }

    // =========================================================
    // PHASE 2 & 3: UI SETUP AND AI FETCH
    // =========================================================
    setTimeout(() => {
      this.isAutoMapping = true;
      this.autoMapProgress = { current: 0, total: unmappedSourcePayload.length };

      // Turn on inline spinners
      unmappedSourcePayload.forEach((field) => {
        const mappingRow = this.mappings.find((m) => m.sourceField === field.name);
        if (mappingRow) mappingRow._isAiProcessing = true;
      });

      this.mappings = [...this.mappings];

      const CHUNK_SIZE = 50;
      let currentIndex = 0;
      let aiMatchCount = 0;

      const processNextChunk = () => {
        if (currentIndex >= unmappedSourcePayload.length) {
          setTimeout(() => {
            this.isAutoMapping = false;
            const totalMapped = heuristicMatchCount + aiMatchCount;

            if (totalMapped > 0) {
              if (this.toastr) this.toastr.success(`Successfully mapped ${totalMapped} fields!`, 'Hybrid Auto-Map Complete');
              if (this.logMessages) this.logMessages.unshift(`System: Hybrid Auto-mapping complete.`);

              this.reviewFilter = 'mapped';
            } else {
              if (this.toastr) this.toastr.info(`No matches found by rules or AI.`, 'Auto-Map Finished');

              this.reviewFilter = 'unmapped';
            }

            this.openReviewPanel();

            this.mappings = [...this.mappings];
            if (typeof this.updateMappedCount === 'function') this.updateMappedCount();
          }, 600);

          return;
        }

        const currentChunk = unmappedSourcePayload.slice(currentIndex, currentIndex + CHUNK_SIZE);
        const targetFieldsAtRequestTime = new Set(this.targetFields.map((t) => t.name));

        this.mappingApi
          .getAiAutoMapping(currentChunk, this.targetFields)
          .pipe(takeUntil(this.mappingCancel$))
          .subscribe({
          next: (response: any) => {
            if (response && Array.isArray(response.mappings)) {
              response.mappings.forEach((backendMap: any) => {
                const localRow = this.mappings.find((m) => m.sourceField === backendMap.sourceField);
                const targetAlreadyClaimed = this.mappings.some(
                  (m) => m.sourceField !== backendMap.sourceField && m.targetField === backendMap.targetField
                );
 
                const isStillValidTarget = backendMap.targetField && targetFieldsAtRequestTime.has(backendMap.targetField);

                if (localRow && !localRow.targetField && isStillValidTarget && !targetAlreadyClaimed) {
                  localRow.targetField = backendMap.targetField;

                  if (typeof this.isReferenceField === 'function' && this.isReferenceField(backendMap.targetField)) {
                    localRow.relationalExtIdField = 'Id';
                  }
                  localRow._mappedBy = 'ai';
                  aiMatchCount++;
                }
              });
            }

            currentChunk.forEach((field) => {
              const mappingRow = this.mappings.find((m) => m.sourceField === field.name);
              if (mappingRow) mappingRow._isAiProcessing = false;
            });

            this.autoMapProgress.current += currentChunk.length;
            this.mappings = [...this.mappings];
            this.cdr.detectChanges();

            if (typeof this.updateMappedCount === 'function') this.updateMappedCount();

            currentIndex += CHUNK_SIZE;
            processNextChunk();
          },
          error: (error: any) => {
            console.error('[FRONTEND ERROR]: AI Chunk failed:', error);
            this.isAutoMapping = false;

            this.mappings.forEach((m) => (m._isAiProcessing = false));
            this.mappings = [...this.mappings];
            this.cdr.detectChanges();

            if (this.toastr) {
              if (error.status === 404) {
                this.toastr.error('Backend endpoint not found (404).', 'Connection Error');
              } else {
                this.toastr.warning('The SureShift Agent connection was interrupted. Partial mappings saved.', 'Incomplete');
              }
            }
          }
        });
      };

      processNextChunk();
    });
  }

  updateMappedCount() {
    const validTargetFieldNames = new Set(this.targetFields.map((f) => f.name));
    this.mappings.forEach((m) => {
      if (m.targetField && !validTargetFieldNames.has(m.targetField)) {
        m.targetField = '';
        m.relationalExtIdField = '';
        delete m._mappedBy;
      }
    });

    this.mappedCount = this.mappings.filter((m) => m.targetField !== '').length;
    this.cdr.detectChanges();
  }

  async validateData(isRevalidation: boolean = false, fixedRecords: any[] = []) {
    if (this.mappedCount === 0) {
      this.toastr.error('Validation Aborted: You must map at least one field to validate data.');
      return;
    }

    if (!isRevalidation && this.customQuery && !this.validateQuery()) {
      this.jobStatus = 'Validation Failed';
      this.toastr.error('Please fix your query criteria before validating.', 'Query Error');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (!this.validateDateRange()) {
      this.jobStatus = 'Validation Failed';
      this.toastr.error(this.dateRangeError!, 'Migration Filter Error');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if ((this.operationMode === 'update' || this.operationMode === 'upsert') && !this.externalIdField) {
      this.jobStatus = 'Validation Failed';
      this.toastr.error(
        `Please select an External ID field to match existing ${this.targetSystem} records for ${this.operationMode.toUpperCase()}.`,
        'External ID Required'
      );
      return;
    }

    if (
      (this.operationMode === 'update' || this.operationMode === 'upsert') &&
      this.externalIdField &&
      !this.isExternalIdEligible(this.targetFields.find((f) => f.name === this.externalIdField) || { name: '', label: '' })
    ) {
      this.jobStatus = 'Validation Failed';
      this.toastr.error(
        `"${this.getTargetFieldLabel(this.externalIdField)}" isn't marked as an External ID (or indexed/lookup) field in ${this.targetSystem}, ` +
        `so it can't be used to match records for ${this.operationMode.toUpperCase()}. Mark the field as an External ID in ${this.targetSystem} Setup, or choose a different field.`,
        'Field Not Usable for Matching'
      );
      return;
    }

    if (
      (this.operationMode === 'update' || this.operationMode === 'upsert') &&
      this.externalIdField &&
      !this.restrictToQueryFields(this.mappings).some((m) => m.targetField === this.externalIdField)
    ) {
      this.jobStatus = 'Validation Failed';
      const rawMapping = this.mappings.find((m) => m.targetField === this.externalIdField);
      const message = rawMapping && this.getQueryFieldFilterSet()
        ? `Your External ID source field "${rawMapping.sourceField}" isn't in your query's SELECT list, so it won't be extracted. Add it to your query, or unmap it and choose a field the query actually selects.`
        : `The External ID field "${this.getTargetFieldLabel(this.externalIdField)}" isn't mapped to a source column, so every record would fail to match. Map a source field to it first.`;
      this.toastr.error(message, 'External ID Not Mapped');
      return;
    }

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

    const activeMappings = this.restrictToQueryFields(this.mappings.filter((m) => m.targetField)).map((m) => {
        const targetMeta = this.targetFields.find((t) => t.name === m.targetField);
        return {
          csvField: m.sourceField,
          sfField: m.targetField,
          sourceField: m.sourceField,
          targetField: m.targetField,
          type: targetMeta?.type || 'string',
          isRequired: targetMeta?.isRequired || targetMeta?.required || false
        };
      });

    const sfRules: any = {};
    this.targetFields.forEach((field) => {
      sfRules[field.name] = field;
    });

    let safeQuery = this.customQuery.trim();
    const crmContext = this.sourceCrmId.toLowerCase();
    if (crmContext === 'zendesk' && !this.isStandardZendeskObject(this.selectedSourceObject)) {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();

      const cleanBlankTemplate = this.ZENDESK_CUSTOM_OBJECT_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = '';
      }
    }

    if (this.sourceCrmId.toLowerCase() === 'hubspot') {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const cleanBlankTemplate = this.HUBSPOT_SEARCH_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = '';
      }
    }

    const payload = {
      isRevalidation: isRevalidation,
      sessionId: this.currentSessionId,
      fixedRecords: fixedRecords,
      crmId: this.sourceCrmId,
      targetCrmId: this.targetCrmId,
      objectName: this.selectedSourceObject,
      query: safeQuery,
      mappings: activeMappings,
      dedupeKey: this.externalIdField,
      sfRules: sfRules,
      authToken: localStorage.getItem('supabase_token') || '',
      migrationTimeFilter: this.migrationTimeFilter
    };


    this.closeSocket(this.validationSocket);

    const ws = new WebSocket(`${environment.wsUrl}/ws/validate-stream`);
    this.validationSocket = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      this.zone.run(() => {
        const data = JSON.parse(event.data);

        if (data.log) {
          this.logMessages.push(data.log);
          if (this.logMessages.length > 50) this.logMessages.shift();
        }

        if (data.status) {
          this.jobStatus = data.status;
        }

        if (data.stats) {
          this.aggregateStats = data.stats;
        }

        if ((data.status === 'Validation Passed' || data.status === 'Validation Warning') && data.invalidRecords) {
          this.validationResults.invalidRecords = data.invalidRecords;
          if (data.sessionId) {
            this.currentSessionId = data.sessionId;
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
        if (this.validationSocket === ws) this.validationSocket = null;
        this.logError(' WebSocket Error: Validation stream disconnected.');
        this.jobStatus = 'Validation Failed';
        this.isValidating = false;
        Swal.fire({
          title: 'Connection Lost',
          text: 'The server disconnected unexpectedly while streaming data. Please check your network or server logs and try again.',
          icon: 'error',
          confirmButtonColor: '#0d6efd',
          customClass: { popup: 'rounded-4 shadow-lg border-0' }
        });
        this.cdr.detectChanges();
      });
    };

    ws.onclose = () => {
      this.zone.run(() => {
        if (this.validationSocket === ws) this.validationSocket = null;
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

    if (!this.validationResults || !this.validationResults.invalidRecords || this.validationResults.invalidRecords.length === 0) {
      return;
    }

    let updatedCount = 0;

    this.validationResults.invalidRecords.forEach((record: any) => {
      if (this.hasCellError(record, sourceField)) {
        record.originalRow[sourceField] = value;
        this.markAsEdited(record, sourceField);
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      this.toastr.success(
        `Updated '${sourceField}' across ${updatedCount} records. Correct data was left untouched!`,
        'Mass Update Applied'
      );
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

    const recordsToTest = this.validationResults.invalidRecords.map((ir: any) => ir.originalRow);

    await this.validateData(true, recordsToTest);
  }

  goBackToConnection(): void {
    this.router.navigate(['/connection']);
  }

  returnToHome(): void {
    this.router.navigate(['/connection']);
  }

  logout(): void {
    Swal.fire({
      title: 'Ready to Leave?',
      text: 'Are you sure you want to log out? Any unsaved mapping progress will be lost.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc3545',
      cancelButtonColor: '#6c757d',
      confirmButtonText: 'Yes, Logout',
      customClass: { popup: 'rounded-4 shadow-lg border-0' }
    }).then((result) => {
      if (result.isConfirmed) {
        if (this.validationSocket && this.validationSocket.readyState === WebSocket.OPEN) {
          this.validationSocket.close();
        }
        if (this.migrationSocket && this.migrationSocket.readyState === WebSocket.OPEN) {
          this.migrationSocket.close();
        }


        localStorage.removeItem('source_crm_slot');
        localStorage.removeItem('target_crm_slot');

        this.toastr.success('You have been securely logged out.', 'Goodbye!');
        this.authService.logout();
      }
    });
  }

  formatCellValue(val: any): string {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  downloadCSV(raw_data: any[], filename: string) {
    if (!raw_data || raw_data.length === 0) return;

    const data = raw_data.map((row) => this.flattenObject(row));

    const headerSet = new Set<string>();
    data.forEach((row) => Object.keys(row).forEach((key) => headerSet.add(key)));
    const headers = Array.from(headerSet);

    const csvRows = [];
    csvRows.push(headers.join(','));

    for (const row of data) {
      const values = headers.map((header) => {
        let val = row[header];

        if (val !== null && typeof val === 'object') {
          val = JSON.stringify(val);
        }

        const stringVal = String(val !== undefined && val !== null ? val : '');

        if (/^\d{16,}$/.test(stringVal)) {
          return `"\t${stringVal}"`;
        }

        const escaped = stringVal.replace(/"/g, '""');
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
    if (this.hasPendingEdits) {
      this.toastr.warning(
        'You have un-validated fixes in the grid. Please click "Re-Validate Fixes" before running the migration.',
        'Action Required'
      );
      const revalBtn = document.querySelector('.btn-danger.fw-bold') as HTMLElement;
      if (revalBtn) {
        revalBtn.classList.add('animate__animated', 'animate__headShake');
        setTimeout(() => revalBtn.classList.remove('animate__headShake'), 1000);
      }
      return;
    }

    const { errors, warnings } = this.getValidationIssues();

    if (errors.length > 0) {
      this.jobStatus = 'Failed';
      this.toastr.error(errors[0], 'Migration Error');
      return;
    }

    const activeMappings = this.restrictToQueryFields(this.mappings.filter((m) => m.targetField !== ''));

    if (warnings.missingFields.length > 0 || warnings.incompleteRefs.length > 0) {
      this.show_warning_modal(warnings);
    } else {
      this.show_confirmation_modal(activeMappings);
    }
  }

  private getValidationIssues() {
    const errors: string[] = [];
    const warnings = {
      missingFields: this.getMissingRequiredFields(),
      incompleteRefs: this.getIncompleteReferenceMappings()
    };

    if (this.customQuery && !this.validateQuery()) {
      errors.push('Please fix your query criteria before running.');
    }

    if (!this.validateDateRange()) {
      errors.push(this.dateRangeError!);
    }

    const activeMappings = this.restrictToQueryFields(this.mappings.filter((m) => m.targetField !== ''));
    if (activeMappings.length === 0) {
      errors.push('Please map at least one field before running the migration.');
    }

    const isUpdateMode = this.operationMode === 'update' || this.operationMode === 'upsert';
    if (isUpdateMode) {
      if (!this.externalIdField) {
        errors.push(`Please select an External ID field to match existing ${this.targetSystem} records for ${this.operationMode.toUpperCase()}.`);
      } else {
        const targetFieldMeta = this.targetFields.find((f) => f.name === this.externalIdField);
        const isEligible = this.isExternalIdEligible(targetFieldMeta || { name: '', label: '' });

        if (!isEligible) {
          errors.push(`"${this.getTargetFieldLabel(this.externalIdField)}" isn't marked as an External ID in ${this.targetSystem}. Mark it in Setup or choose another field.`);
        } else if (!activeMappings.some((m) => m.targetField === this.externalIdField)) {
          const rawMapping = this.mappings.find((m) => m.targetField === this.externalIdField);
          if (rawMapping && this.getQueryFieldFilterSet()) {
            errors.push(`Your External ID source field "${rawMapping.sourceField}" isn't in your query's SELECT list, so it won't be extracted. Add it to your query, or unmap it and choose a field the query actually selects.`);
          } else {
            errors.push(`The External ID field "${this.getTargetFieldLabel(this.externalIdField)}" isn't mapped to a source column.`);
          }
        }
      }
    }

    if (!this.selectedSourceObject || !this.selectedTargetObject) {
      errors.push('Source and Target objects must be selected.');
    }

    return { errors, warnings };
  }

  private show_warning_modal(warnings: { missingFields: string[], incompleteRefs: string[] }) {
    let warningHtml = '<div class="text-start mt-2">';

    if (warnings.missingFields.length > 0) {
      warningHtml += `<p class="text-danger fw-bold mb-1"><i class="feather icon-alert-triangle"></i> Missing Required Fields:</p>
                       <ul class="small mb-3 text-muted"><li class="mb-0">${warnings.missingFields.join('</li><li_item>')}</li></ul>`;
    }

    if (warnings.incompleteRefs.length > 0) {
      warningHtml += `<p class="text-warning text-dark fw-bold mb-1"><i class="feather icon-link"></i> Incomplete Lookups:</p>
                       <p class="small mb-1 text-muted">You mapped these relational fields but left the <strong>Parent Ext ID</strong> blank (Defaults to 'Id'):</p>
                       <ul class="small mb-0 text-muted"><li class="mb-0">${warnings.incompleteRefs.join('</li><li_item>')}</li></ul>`;
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
        const activeMappings = this.restrictToQueryFields(this.mappings.filter((m) => m.targetField !== ''));
        this.executeMigrationJob(activeMappings);
      } else {
        this.jobStatus = 'Idle';
      }
    });
  }

  private show_confirmation_modal(activeMappings: any[]) {
    Swal.fire({
      title: 'Ready to Migrate!',
      text: `Are you sure you want to execute this ${this.operationMode.toUpperCase()} job? This will push live data into ${this.selectedTargetObject}.`,
      icon: 'info',
      showCancelButton: true,
      confirmButtonColor: '#198754',
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

  downloadAudit(type: 'valid' | 'invalid') {
  if (!this.currentSessionId) {
    this.toastr.error('Session expired. Please run the validation stream again to generate a new report.', 'No Session');
    return;
  }

  if (type === 'invalid' && this.validationResults?.invalidRecords) {
    this.toastr.info(`Generating error audit report...`, 'Downloading');
    this.downloadCSV(this.validationResults.invalidRecords, 'validation_errors.csv');
    return;
  }

  this.toastr.info(`Generating valid audit report...`, 'Downloading');
  const url = `${environment.apiUrl}/api/audit/download/${this.currentSessionId}?type=${type}`;
  const token = localStorage.getItem('supabase_token') || '';

  this.http.get(url, {
    responseType: 'blob',
    headers: { Authorization: `Bearer ${token}` }
  }).subscribe({
    next: (blob) => {
      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `Validation_Audit_${type}_${this.currentSessionId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(objectUrl);
    },
    error: () => this.toastr.error('Failed to download audit report.', 'Download Failed')
  });
}

  private executeMigrationJob(activeMappings: any[]) {
    this.successData = [];
    this.errorData = [];
    this.skippedData = [];
    this.jobStatus = 'Initializing...';
    this.logMessages = [];
    this.isGlobalLoading = true;
    this.globalLoadingText = `Migrating to ${this.targetSystem}...`;
    this.globalLoadingSubText = `Pushing data into ${this.selectedTargetObject}. Please do not close this window.`;
    this.cdr.detectChanges();
    this.toastr.info('Connecting to Migration Engine...', 'Job Started');

    const enhancedMappings = activeMappings.map((m) => {
      const fieldMeta = this.targetFields.find((t) => t.name === m.targetField);
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
    if (this.sourceCrmId.toLowerCase() === 'zendesk' && !this.isStandardZendeskObject(this.selectedSourceObject)) {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();

      const cleanBlankTemplate = this.ZENDESK_CUSTOM_OBJECT_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = '';
      }
    }

    if (this.sourceCrmId.toLowerCase() === 'hubspot') {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const cleanBlankTemplate = this.HUBSPOT_SEARCH_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = '';
      }
    }

    const fixedRecords =
      this.validationResults?.invalidRecords?.filter((rec: any) => rec._editedFields)?.map((rec: any) => rec.originalRow) || [];

    const job = {
      sessionId: this.currentSessionId,
      fixedRecords: fixedRecords,
      sourceObject: this.selectedSourceObject,
      targetObject: this.selectedTargetObject,
      sourceCrmId: this.sourceCrmId,
      targetCrmId: this.targetCrmId,
      extractionQuery: safeQuery,
      mappings: enhancedMappings,
      operationMode: this.operationMode,
      batchSize: this.batchSize,
      externalIdField: this.externalIdField,
      migrateAttachments: this.isSalesforceToSalesforce ? this.migrateAttachments : false,
      migrateFiles: this.isSalesforceToSalesforce ? this.migrateFiles : false,
      migrationTimeFilter: this.migrationTimeFilter,

      authToken: localStorage.getItem('supabase_token') || ''
    };

    const payload = { queue: [job] };

    this.closeSocket(this.migrationSocket);

    const ws = new WebSocket(`${environment.wsUrl}/ws/migrate`);
    this.migrationSocket = ws;

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

          if (data.status === 'Finished') {
            this.isGlobalLoading = false;
            const successCount = data.successData ? data.successData.length : 0;
            const errorCount = data.errorData ? data.errorData.length : 0;
            const skippedCount = data.skippedData ? data.skippedData.length : 0;

            let swalIcon: 'success' | 'warning' | 'error' = 'success';
            let swalTitle = 'Migration Complete!';

            if (errorCount > 0 && successCount > 0) {
              swalIcon = 'warning';
              swalTitle = 'Migration Finished with Errors';
            } else if (errorCount > 0 && successCount === 0) {
              swalIcon = 'error';
              swalTitle = 'Migration Failed';
            } else if (skippedCount > 0) {
              swalTitle = 'Migration Complete (Some Records Skipped)';
            }

            Swal.fire({
              title: swalTitle,
              html: `
                <div class="text-center mt-3">
                  <div class="d-flex justify-content-around mb-4 gap-3">
                    <div class="p-3 border rounded border-success-subtle bg-success-subtle w-100 shadow-sm">
                      <h2 class="text-success mb-0 fw-bold">${successCount}</h2>
                      <span class="small fw-bold text-success-emphasis text-uppercase">Successful</span>
                    </div>
                    ${skippedCount > 0 ? `
                    <div class="p-3 border rounded border-warning-subtle bg-warning-subtle w-100 shadow-sm">
                      <h2 class="text-warning-emphasis mb-0 fw-bold">${skippedCount}</h2>
                      <span class="small fw-bold text-warning-emphasis text-uppercase">Skipped (No Match)</span>
                    </div>` : ''}
                    <div class="p-3 border rounded border-danger-subtle bg-danger-subtle w-100 shadow-sm">
                      <h2 class="text-danger mb-0 fw-bold">${errorCount}</h2>
                      <span class="small fw-bold text-danger-emphasis text-uppercase">Rejected</span>
                    </div>
                  </div>
                  <p class="text-muted small mb-0">Check the terminal logs or download the reports below to review the details.</p>
                </div>
              `,
              icon: swalIcon,
              confirmButtonText: 'View Logs',
              confirmButtonColor: '#0d6efd',
              customClass: { popup: 'rounded-4 shadow-lg border-0' }
            });
          }
        }

        if (data.successData) this.successData = data.successData;
        if (data.errorData) this.errorData = data.errorData;
        if (data.skippedData) this.skippedData = data.skippedData;

        this.cdr.detectChanges();
        setTimeout(() => {
          const logContainer = document.querySelector('#terminal-window');
          if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
        }, 10);
      });
    };

    ws.onerror = () => {
      this.zone.run(() => {
        if (this.migrationSocket === ws) this.migrationSocket = null;
        this.isGlobalLoading = false;
        this.logMessages.push('FATAL: Connection to migration engine lost or refused.');
        this.jobStatus = 'Failed';
        this.toastr.error('WebSocket connection failed.', 'Engine Error');
        Swal.fire({
          title: 'Connection Lost',
          text: 'The server disconnected unexpectedly while streaming data. Please check your network or server logs and try again.',
          icon: 'error',
          confirmButtonColor: '#0d6efd',
          customClass: { popup: 'rounded-4 shadow-lg border-0' }
        });
        this.cdr.detectChanges();
      });
    };

    ws.onclose = () => {
      this.zone.run(() => {
        if (this.migrationSocket === ws) this.migrationSocket = null;
        this.isGlobalLoading = false;
        if (this.jobStatus === 'Running' || this.jobStatus === 'Initializing...') {
          this.jobStatus = 'Disconnected';
        }
        this.cdr.detectChanges();
      });
    };
  }
}