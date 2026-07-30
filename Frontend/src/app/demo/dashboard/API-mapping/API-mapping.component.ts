import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, ChangeDetectorRef, NgZone, HostListener, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from 'src/app/theme/shared/components/breadcrumbs/breadcrumbs.component';
import { MappingApiService } from 'src/app/services/mapping-api.service';
import { ToastrService } from 'ngx-toastr';
import Swal from 'sweetalert2';
import { EditorComponent } from 'ngx-monaco-editor-v2';
import { environment } from 'src/environments/environment';

declare const monaco: any;
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
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent, EditorComponent],
  templateUrl: './API-mapping.component.html',
  styleUrls: ['./API-mapping.component.scss']
})
export class ApiMappingComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private mappingApi = inject(MappingApiService);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  private toastr = inject(ToastrService);
  private validationSocket: WebSocket | null = null;
  private migrationSocket: WebSocket | null = null;
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

      // If it's a nested object (like originalRow), flatten its keys into top-level columns
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

  // Execution Variables
  jobStatus = 'Idle';
  logMessages: string[] = [];
  customQuery: string = '';
  queryError: string | null = null;
  isPreviewLoading = false;
  sourceFields: FieldMeta[] = [];
  successData: any[] = [];
  isQueueMinimized: boolean = false;
  errorData: any[] = [];
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

  operationMode: string = 'insert';
  batchSize: number = 5000;
  migrationQueue: any[] = [];

  // Files & Attachments (Salesforce -> Salesforce only, for now)
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
    // 1. Securely pull the intended CRMs
    const navState = history.state;
    this.sourceCrmId = navState?.sourceCrm || localStorage.getItem('source_crm_slot');
    this.targetCrmId = navState?.targetCrm || localStorage.getItem('target_crm_slot');

    if (!this.sourceCrmId || !this.targetCrmId) {
      this.toastr.warning('Please connect your Source and Target systems first.', 'Connections Required');
      this.router.navigate(['/connection']); // Or whatever your route is named
      return;
    }

    this.sourceSystem = this.sourceCrmId;
    this.targetSystem = this.targetCrmId;
    this.batchSize = this.batchConfig.default;

    // Save them so a page refresh doesn't break the app
    localStorage.setItem('source_crm_slot', this.sourceCrmId);
    localStorage.setItem('target_crm_slot', this.targetCrmId);

    this.recentQueries = JSON.parse(localStorage.getItem('crm_query_history') || '[]');

    this.fetchRecoverableSessions();

    this.preloadEntirePage();
  }

  ngOnDestroy() {
    // 1. Kill active websockets
    if (this.validationSocket && this.validationSocket.readyState === WebSocket.OPEN) {
      this.validationSocket.close();
    }
    if (this.migrationSocket && this.migrationSocket.readyState === WebSocket.OPEN) {
      this.migrationSocket.close();
    }

    // 2. Kill the VS Code engine to free up RAM
    if (this.monacoEditorInstance) {
      this.monacoEditorInstance.dispose();
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
    // 1. Update the UI state to match the old session
    this.currentSessionId = sessionId;
    this.sourceCrmId = crm.toLowerCase();
    this.selectedSourceObject = object.toLowerCase();

    this.toastr.info(`Restoring previous session...`, 'Resuming');

    // 2. Trigger the WebSocket with Revalidation = true, passing empty records
    // Your Python backend will see the ID, skip API extraction, and instantly return the DB errors!
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

  get visibleMappings() {
    let filtered = this.mappings;

    // 1. Filter out already mapped fields if toggled
    if (this.hideMappedFields) {
      filtered = filtered.filter((m) => !m.targetField);
    }

    // 2. Filter by the user's search query (matches field name or label)
    if (this.mappingSearchQuery) {
      const query = this.mappingSearchQuery.toLowerCase().trim();
      filtered = filtered.filter(
        (m) =>
          (m.sourceLabel && m.sourceLabel.toLowerCase().includes(query)) || (m.sourceField && m.sourceField.toLowerCase().includes(query))
      );
    }

    return filtered;
  }

  changePreviewLimit(newLimit: number) {
    // Force JavaScript to treat the dropdown value as a number
    this.previewLimit = Number(newLimit);

    // If they already selected an object, instantly fetch the new rows!
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

    // Check if ANY record has the _editedFields object with at least one true value
    return this.validationResults.invalidRecords.some((rec: any) => rec._editedFields && Object.keys(rec._editedFields).length > 0);
  }

  isTypeMismatch(mapping: any): boolean {
    if (!mapping.targetField) return false;
    const srcType = this.getFieldMeta(mapping.sourceField, 'source')?.type?.toLowerCase() || 'string';
    const tgtType = this.getFieldMeta(mapping.targetField, 'target')?.type?.toLowerCase() || 'string';

    if (srcType === tgtType) return false;

    //  Strings can usually map to picklists or text areas
    if (srcType.includes('string') && ['string', 'text', 'textarea', 'picklist', 'reference'].includes(tgtType)) return false;
    // Numbers can map to other numbers
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
            // --- NEW: Context-Aware Value Suggestions ---
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
              return { suggestions: suggestions }; // Return early so ONLY statuses show up
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
            suggestions.push({
              label: 'SELECT (Basic)',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: `SELECT * FROM ${this.selectedSourceObject || 'Object'} WHERE `,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Auto-generates a basic SELECT query for the current object.',
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

          // CLEANUP: Strip out Zendesk operators (:, <, >) so we can match the pure field name
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

  // Overwrite the old inject function to use Monaco's cursor placement
  injectFieldAtCursor(fieldName: string) {
    if (this.monacoEditorInstance) {
      // Get the user's current cursor position inside the editor
      const position = this.monacoEditorInstance.getPosition();

      // Inject the text exactly where they clicked
      this.monacoEditorInstance.executeEdits('custom-inject', [
        {
          range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          text: fieldName + ' ',
          forceMoveMarkers: true
        }
      ]);

      // Keep the editor focused so they can keep typing
      this.monacoEditorInstance.focus();
      this.customQuery = this.monacoEditorInstance.getValue();
    } else {
      // Fallback just in case Monaco hasn't fully loaded
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
  }

  // --- ADD THIS TEMPLATE CONSTANT ---
  readonly ZENDESK_CUSTOM_OBJECT_TEMPLATE = `/* Zendesk Custom Object Query Template 
 - Leave blank to fetch all records.
 - Prefix custom fields with 'custom_object_fields.' 
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

    if (crm === 'zendesk') {
      if (this.isStandardZendeskObject(entityName)) {
        let singularName = entityName.toLowerCase();
        if (singularName.endsWith('s') && singularName !== 'macros') {
          singularName = singularName.slice(0, -1);
        }
        this.customQuery = `type:${singularName} `;
      } else {
        // --- UPGRADED: Auto-inject the custom layout instructions ---
        this.customQuery = this.ZENDESK_CUSTOM_OBJECT_TEMPLATE;
      }
    } else if (crm === 'hubspot') {
      this.customQuery = this.HUBSPOT_SEARCH_TEMPLATE;
    } else if (crm === 'salesforce') {
      this.customQuery = `SELECT * FROM ${entityName}`;
    } else if (crm === 'zoho') {
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
    if (!fieldName || fieldName === '') {
      mapping._mappedBy = null;
    }
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
    let filtered = this.targetFields;

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

    // const crm = this.sourceCrmId.toLowerCase();

    // if (crm === 'zendesk') {
    //   let singularName = entityName.toLowerCase();
    //   if (singularName.endsWith('s') && singularName !== 'macros') {
    //     singularName = singularName.slice(0, -1);
    //   }
    //   this.customQuery = `type:${singularName} `;

    // } else if (crm === 'salesforce') {
    //   this.customQuery = `SELECT * FROM ${entityName}`;

    // } else {
    //   this.customQuery = `SELECT * FROM ${entityName} WHERE `;
    // }

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
    return this.sourceEntities.filter((e) => e.label.toLowerCase().includes(lowerQuery) || e.name.toLowerCase().includes(lowerQuery));
  }

  getFilteredTargetEntities(): any[] {
    if (!this.targetSearchQuery) return this.targetEntities;
    const lowerQuery = this.targetSearchQuery.toLowerCase();
    return this.targetEntities.filter((e) => e.label.toLowerCase().includes(lowerQuery) || e.name.toLowerCase().includes(lowerQuery));
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
          ? "Use JSON. Prefix custom fields with 'custom_object_fields.'. Leave blank for all records."
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
        helpText: 'Use HubSpot JSON search syntax to filter records. Leave blank to fetch all.',
        icon: 'icon-filter',
        buttonText: 'Apply Filter',
        loadingText: 'Filtering...'
      };
    } else if (crm === 'salesforce') {
      return {
        title: 'SOQL Query Editor',
        placeholder: 'e.g., SELECT * FROM Account WHERE Amount > 5000 LIMIT 100',
        helpText: 'Write your full SOQL query to filter data, or append LIMIT to restrict the migration size.',
        icon: 'icon-database',
        buttonText: 'Run Query',
        loadingText: 'Querying...'
      };
    } else if (crm === 'zoho') {
      return {
        title: 'Zoho COQL Editor',
        placeholder: "e.g., SELECT * FROM Accounts WHERE Industry = 'Technology' LIMIT 200",
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

    if (!this.validateQuery()) {
      return;
    }

    this.isPreviewLoading = true;
    this.previewRecords = [];
    this.cdr.detectChanges();
    this.saveQueryToHistory(this.customQuery);

    let safeQuery = this.customQuery.trim();

    // --- ADD THIS CLEANING BLOCK FOR CUSTOM OBJECTS ---
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
      authToken: localStorage.getItem('supabase_token') || ''
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

      // --- DETAILED ERROR LOGGING EXTRACTED FROM BACKEND ---
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown Server Error' }));
        throw new Error(errorData.detail || 'Failed to fetch filtered data.');
      }

      const data = await response.json();
      this.previewRecords = data.records || [];
      this.logMessages = [...this.logMessages, `System: Source preview updated using filter -> [${this.customQuery}]`];
    } catch (error: any) {
      console.error('Filter Error:', error);
      this.previewRecords = [];

      // --- Bind the CRM API error directly to the query editor! ---
      const errorMessage = error.message || 'Invalid Query Syntax rejected by CRM.';
      this.queryError = `API Error: ${errorMessage}`;

      // Show popup and log it
      this.toastr.error('Your query was rejected by the source CRM.', 'Query Error');
      this.logMessages = [...this.logMessages, ` API Error: ${errorMessage}`];
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

    //  Clear existing red squiggles every time they type
    if (this.monacoEditorInstance) {
      monaco.editor.setModelMarkers(this.monacoEditorInstance.getModel(), 'sql-validation', []);
    }

    if (!this.customQuery) return true;

    const queryLower = this.customQuery.trim().toLowerCase();
    const crm = this.sourceCrmId.toLowerCase();

    //  Helper Function to Draw Red Squiggles
    const applySquiggle = (errorMsg: string, offendingText: string): boolean => {
      this.queryError = errorMsg;

      if (this.monacoEditorInstance && offendingText) {
        const model = this.monacoEditorInstance.getModel();
        const fullText = model.getValue().toLowerCase();

        // Find exactly where the bad text starts in the query
        const startIndex = fullText.indexOf(offendingText.toLowerCase());

        if (startIndex !== -1) {
          const startPos = model.getPositionAt(startIndex);
          const endPos = model.getPositionAt(startIndex + offendingText.length);

          // Command Monaco to draw the red squiggly line!
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
        // 1. Empty is perfectly fine (Fetches all recent)
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
      // Tell the backend EXACTLY which DB slot to look up
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

        // 2. Turn it off when finished!
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

    // Route the selected field through your Monaco cursor injector
    this.injectFieldAtCursor(fieldName);

    // Reset the dropdown back to the placeholder
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
      // Tell the backend EXACTLY which DB slot to look up
      sourceData: this.mappingApi.getFields(this.sourceCrmId, this.selectedSourceObject, 'source'),
      targetData: this.mappingApi.getFields(this.targetCrmId, this.selectedTargetObject, 'target')
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

  clearMapping(mapping: any) {
    mapping.targetField = '';
    mapping._mappedBy = null;
    mapping.relationalExtIdField = '';
    this.mappedCount = this.mappings.filter((m) => m.targetField).length;
    delete mapping._mappedBy;
    delete mapping._mappedBy;
    this.updateMappedCount();
  }

  resetAllMappings() {
    this.mappings.forEach((m) => (m.targetField = ''));

    this.updateMappedCount();
  }

  autoMap(): void {
    // Prevent duplicate double-clicks
    if (this.isAutoMapping || this.isLoading) return;

    // Set loading state
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
    this.mappings.forEach((m) => {
      if (m.targetField) return;

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

        // DATA TYPE COMPATIBILITY CHECK
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
        if (typeof this.isReferenceField === 'function' && this.isReferenceField(bestMatch['name'])) {
          m.relationalExtIdField = 'Id';
        }
        m._mappedBy = 'rule';
        heuristicMatchCount++;
      }
    });

    const unmappedSourcePayload = this.sourceFields.filter((sf) => {
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

        // Opens review panel ONLY when fast-mapping is complete
        this.showReviewPanel = true;
        this.reviewPanelMinimized = false;
        this.reviewFilter = 'mapped';
      } else {
        if (this.toastr) this.toastr.info(`No matches found.`, 'Auto-Map Finished');
      }
      return;
    }

    // =========================================================
    // PHASE 2 & 3: UI SETUP AND AI FETCH (DEFERRED)
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

              // Switch to mapped tab to show results
              this.reviewFilter = 'mapped';
            } else {
              if (this.toastr) this.toastr.info(`No matches found by rules or AI.`, 'Auto-Map Finished');
              // Switch to unmapped tab to show what failed
              this.reviewFilter = 'unmapped';
            }

            // Opens review panel ONLY when AI is completely finished
            this.showReviewPanel = true;
            this.reviewPanelMinimized = false;

            this.mappings = [...this.mappings];
            if (typeof this.updateMappedCount === 'function') this.updateMappedCount();
          }, 600);

          return;
        }

        const currentChunk = unmappedSourcePayload.slice(currentIndex, currentIndex + CHUNK_SIZE);

        this.mappingApi.getAiAutoMapping(currentChunk, this.targetFields).subscribe({
          next: (response: any) => {
            if (response && Array.isArray(response.mappings)) {
              response.mappings.forEach((backendMap: any) => {
                const localRow = this.mappings.find((m) => m.sourceField === backendMap.sourceField);

                if (localRow && !localRow.targetField && backendMap.targetField) {
                  localRow.targetField = backendMap.targetField;

                  if (typeof this.isReferenceField === 'function' && this.isReferenceField(backendMap.targetField)) {
                    localRow.relationalExtIdField = 'Id';
                  }
                  localRow._mappedBy = 'ai';
                  aiMatchCount++;
                }
              });
            }

            // Fallback cleanup: Turn off spinners for this chunk
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
      // Scroll to the top so the user sees the red query box
      window.scrollTo({ top: 0, behavior: 'smooth' });
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

    // --- CRITICAL FIX: Add sourceField, targetField, and isRequired so the backend can enforce it ---
    const activeMappings = this.mappings
      .filter((m) => m.targetField)
      .map((m) => {
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
    // --- ADD THIS CLEANING BLOCK FOR VALIDATION STREAM ---
    if (crmContext === 'zendesk' && !this.isStandardZendeskObject(this.selectedSourceObject)) {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();

      const cleanBlankTemplate = this.ZENDESK_CUSTOM_OBJECT_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = ''; // Default to pulling all records if template unmodified
      }
    }

    if (this.sourceCrmId.toLowerCase() === 'hubspot') {
      safeQuery = safeQuery.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const cleanBlankTemplate = this.HUBSPOT_SEARCH_TEMPLATE.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (safeQuery === cleanBlankTemplate) {
        safeQuery = '';
      }
    }

    // Inject the Revalidation flags into the payload
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
      authToken: localStorage.getItem('supabase_token') || ''
    };

    // Connect to the new streaming websocket
    const ws = new WebSocket(`${environment.wsUrl}/ws/validate-stream`);

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

    // Grab all the rows currently in the error grid (including the user's edits)
    const recordsToTest = this.validationResults.invalidRecords.map((ir: any) => ir.originalRow);

    // Pass True to trigger the shortcut in Python
    await this.validateData(true, recordsToTest);
  }

  goBackToConnection(): void {
    // You can also add validation or warning prompts here if the user has unsaved mappings
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
        // 1. Wipe secure tokens and session memory
        localStorage.removeItem('supabase_token');
        localStorage.removeItem('source_crm_slot');
        localStorage.removeItem('target_crm_slot');
        // Or use localStorage.clear(); if you want to wipe absolutely everything

        // 2. Disconnect active websockets
        if (this.validationSocket && this.validationSocket.readyState === WebSocket.OPEN) {
          this.validationSocket.close();
        }
        if (this.migrationSocket && this.migrationSocket.readyState === WebSocket.OPEN) {
          this.migrationSocket.close();
        }

        // 3. Notify and Redirect
        this.toastr.success('You have been securely logged out.', 'Goodbye!');
        this.router.navigate(['/login']); // Change '/login' to your actual auth route if different
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

    // 1. Deeply flatten the data so NO JSON objects appear in your cells!
    const data = raw_data.map((row) => this.flattenObject(row));

    // 2. Extract all unique headers to build the CSV columns
    const headerSet = new Set<string>();
    data.forEach((row) => Object.keys(row).forEach((key) => headerSet.add(key)));
    const headers = Array.from(headerSet);

    const csvRows = [];
    csvRows.push(headers.join(',')); // Add Header Row

    for (const row of data) {
      const values = headers.map((header) => {
        let val = row[header];

        // Catch any leftover arrays
        if (val !== null && typeof val === 'object') {
          val = JSON.stringify(val);
        }

        const stringVal = String(val !== undefined && val !== null ? val : '');

        // FIX: The Invisible Excel Text Hack!
        // Adding a tab character (\t) forces Excel to read the ID as text without showing ugly formulas.
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

      // Flash the Re-Validate button to draw the user's attention
      const revalBtn = document.querySelector('.btn-danger.fw-bold') as HTMLElement;
      if (revalBtn) {
        revalBtn.classList.add('animate__animated', 'animate__headShake');
        setTimeout(() => revalBtn.classList.remove('animate__headShake'), 1000);
      }
      return;
    }
    if (this.customQuery && !this.validateQuery()) {
      this.jobStatus = 'Validation Failed';
      this.toastr.error('Please fix your query criteria before running.', 'Query Error');
      return;
    }

    const activeMappings = this.mappings.filter((m) => m.targetField !== '');

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
  }

  downloadAudit(type: 'valid' | 'invalid') {
    if (!this.currentSessionId) {
      this.toastr.error('Session expired. Please run the validation stream again to generate a new report.', 'No Session');
      return;
    }

    if (type === 'invalid' && this.validationResults?.invalidRecords) {
      this.toastr.info(`Generating error audit report...`, 'Downloading');
      this.downloadCSV(this.validationResults.invalidRecords, 'validation_errors.csv');
    } else {
      // Valid records are handled by the backend because they are too massive for browser RAM
      this.toastr.info(`Generating valid audit report...`, 'Downloading');
      const url = `${environment.apiUrl}/api/audit/download/${this.currentSessionId}?type=${type}`;
      window.open(url, '_blank');
    }
  }

  // --- Separated execution logic for clean popup handling ---
  private executeMigrationJob(activeMappings: any[]) {
    this.successData = [];
    this.errorData = [];
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

    // --- ADD THIS SAME CLEANING BLOCK HERE ---
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

      authToken: localStorage.getItem('supabase_token') || ''
    };

    const payload = { queue: [job] };
    const ws = new WebSocket(`${environment.wsUrl}/ws/migrate`);

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

          // --- THE NEW POST-MIGRATION POPUP ---
          if (data.status === 'Finished') {
            this.isGlobalLoading = false;
            const successCount = data.successData ? data.successData.length : 0;
            const errorCount = data.errorData ? data.errorData.length : 0;

            let swalIcon: 'success' | 'warning' | 'error' = 'success';
            let swalTitle = 'Migration Complete!';

            if (errorCount > 0 && successCount > 0) {
              swalIcon = 'warning';
              swalTitle = 'Migration Finished with Errors';
            } else if (errorCount > 0 && successCount === 0) {
              swalIcon = 'error';
              swalTitle = 'Migration Failed';
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
                    <div class="p-3 border rounded border-danger-subtle bg-danger-subtle w-100 shadow-sm">
                      <h2 class="text-danger mb-0 fw-bold">${errorCount}</h2>
                      <span class="small fw-bold text-danger-emphasis text-uppercase">Rejected</span>
                    </div>
                  </div>
                  <p class="text-muted small mb-0">Check the terminal logs or download the error reports to review rejected records.</p>
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

        this.cdr.detectChanges();
        setTimeout(() => {
          // Auto-scroll the terminal
          const logContainer = document.querySelector('#terminal-window');
          if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
        }, 10);
      });
    };

    ws.onerror = () => {
      this.zone.run(() => {
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
        this.isGlobalLoading = false;
        if (this.jobStatus === 'Running' || this.jobStatus === 'Initializing...') {
          this.jobStatus = 'Disconnected';
        }
        this.cdr.detectChanges();
      });
    };
  }
}