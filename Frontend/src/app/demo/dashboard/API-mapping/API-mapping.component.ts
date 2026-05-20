import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { MappingApiService } from 'src/app/services/mapping-api.service'

interface FieldMeta {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}

interface MappingRow {
  sourceField: string;
  sourceLabel: string;
  targetField: string;
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

  // Execution Variables
  jobStatus = 'Idle';
  logMessages: string[] = [];

  ngOnInit(): void {
    // 1. Establish System Names and IDs
    this.sourceSystem = localStorage.getItem('source_crm_slot') || 'Zendesk';
    this.targetSystem = localStorage.getItem('target_crm_slot') || 'Salesforce';
    
    const navState = history.state;
    this.sourceCrmId = navState?.sourceCrm || localStorage.getItem('source_crm_slot') || 'msdynamics';
    this.targetCrmId = navState?.targetCrm || localStorage.getItem('target_crm_slot') || 'salesforce';

    // 2. Kick off the continuous pipeline to load everything at once
    this.preloadEntirePage();
  }

 /**
   * Pipeline Step 1: Fetch initial objects in parallel, auto-select defaults, 
   * and immediately cascade into pulling the metadata details.
   */
  preloadEntirePage() {
    this.isLoading = true;

    forkJoin({
      sourceObjs: this.mappingApi.getObjects(this.sourceCrmId),
      targetObjs: this.mappingApi.getObjects(this.targetCrmId)
    }).subscribe({
      next: ({ sourceObjs, targetObjs }) => {
        this.sourceEntities = sourceObjs;
        this.targetEntities = targetObjs;

        // FIX: Defer the state updates to the next Angular rendering cycle 
        // to prevent NG0100 ExpressionChanged errors.
        setTimeout(() => {
          // Auto-select smart defaults for Source
          if (this.sourceEntities.length > 0) {
            const defaultSrc = this.sourceEntities.find(e => 
              e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('ticket')
            );
            this.selectedSourceObject = defaultSrc ? defaultSrc.name : this.sourceEntities[0].name;
          }

          // Auto-select smart defaults for Target
          if (this.targetEntities.length > 0) {
            const defaultTgt = this.targetEntities.find(e => 
              e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('user')
            );
            this.selectedTargetObject = defaultTgt ? defaultTgt.name : this.targetEntities[0].name;
          }

          // Immediately execute Step 2 now that the DOM is stable
          this.loadMetadata();
        });
      },
      error: (err) => {
        console.error('Failed to preload base entity dropdowns:', err);
        this.logMessages.unshift(`Configuration Error: Could not fetch core CRM schemas.`);
        this.isLoading = false;
      }
    });
  }

  /**
   * Pipeline Step 2: Fetches fields, schema details, and preview records 
   * for the currently selected/auto-selected items.
   */
  loadMetadata() {
    if (!this.selectedSourceObject || !this.selectedTargetObject) {
      this.isLoading = false;
      return;
    }

    this.isLoading = true;
    
    forkJoin({
      sourceData: this.mappingApi.getFields(this.sourceCrmId, this.selectedSourceObject),
      targetData: this.mappingApi.getFields(this.targetCrmId, this.selectedTargetObject)
    }).subscribe({
      next: ({ sourceData, targetData }) => {
        // Populating target fields
        this.targetFields = targetData.fields;

        // Populating live source preview tracking tables
        this.previewHeaders = sourceData.headers;
        this.previewRecords = sourceData.sampleRecords;

        // Generating dynamic structural mapping topology rows
        this.mappings = sourceData.fields.map((field: FieldMeta) => ({
          sourceField: field.name,
          sourceLabel: field.label,
          targetField: ''
        }));

        this.updateMappedCount();
        this.isLoading = false;
      },
      error: (err) => {
        console.error('Metadata payload extraction failed:', err);
        this.logMessages.unshift(`API Error: Unable to fetch live dataset metrics.`);
        this.isLoading = false;
      }
    });
  }

  // Toolbar Actions
  clearMapping(index: number) {
    this.mappings[index].targetField = '';
    this.updateMappedCount();
  }

  resetAllMappings() {
    this.mappings.forEach(m => m.targetField = '');
    this.updateMappedCount();
  }

  autoMap() {
    // Dynamic matching based on field name or label similarity
    this.mappings.forEach(m => {
      const sourceMatchKey = m.sourceField.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = this.targetFields.find(t => {
        const targetMatchKey = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return targetMatchKey.includes(sourceMatchKey) || sourceMatchKey.includes(targetMatchKey);
      });

      if (match) {
        m.targetField = match.name;
      }
    });
    
    this.updateMappedCount();
    this.logMessages.unshift('System: Dynamic Auto-mapping applied based on field topology matching.');
  }

  updateMappedCount() {
    this.mappedCount = this.mappings.filter(m => m.targetField !== '').length;
  }

  // Execution Bottom Panel
  runMigration() {
    this.jobStatus = 'Running...';
    this.logMessages = [
      `Initializing API connection to ${this.targetCrmId}...`,
      `Compiling mapping schema for ${this.selectedSourceObject} ➔ ${this.selectedTargetObject}...`,
      `Fetching live batched records from ${this.sourceCrmId}...`
    ];

    // Mocking the execution delay for UI purposes (connect to backend execution endpoint next)
    setTimeout(() => {
      this.logMessages.unshift('Batch 1 payload successfully upserted.');
      this.logMessages.unshift('Job Complete: Live migration sequence executed.');
      this.jobStatus = 'Completed';
    }, 2000);
  }
}