import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, ChangeDetectorRef, NgZone } from '@angular/core';
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
    this.cdr.detectChanges(); // Force UI to show loading state

    forkJoin({
      sourceObjs: this.mappingApi.getObjects(this.sourceCrmId),
      targetObjs: this.mappingApi.getObjects(this.targetCrmId)
    }).subscribe({
      next: ({ sourceObjs, targetObjs }) => {
        this.sourceEntities = sourceObjs || [];
        this.targetEntities = targetObjs || [];

        // Auto-select smart defaults for Source
        if (this.sourceEntities.length > 0) {
          const defaultSrc = this.sourceEntities.find(
            (e) => e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('ticket')
          );
          this.selectedSourceObject = defaultSrc ? defaultSrc.name : this.sourceEntities[0].name;
        }

        // Auto-select smart defaults for Target
        if (this.targetEntities.length > 0) {
          const defaultTgt = this.targetEntities.find(
            (e) => e.name.toLowerCase().includes('account') || e.name.toLowerCase().includes('user')
          );
          this.selectedTargetObject = defaultTgt ? defaultTgt.name : this.targetEntities[0].name;
        }

        // Force UI to acknowledge the dropdown selections before firing next API
        this.cdr.detectChanges();

        // Immediately execute Step 2
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

  /**
   * Pipeline Step 2: Fetches fields, schema details, and preview records
   * for the currently selected/auto-selected items.
   */
  loadMetadata() {
    if (!this.selectedSourceObject || !this.selectedTargetObject) {
      this.isLoading = false;
      this.cdr.detectChanges();
      return;
    }

    this.isLoading = true;
    this.cdr.detectChanges(); // Force spinner to appear

    forkJoin({
      sourceData: this.mappingApi.getFields(this.sourceCrmId, this.selectedSourceObject),
      targetData: this.mappingApi.getFields(this.targetCrmId, this.selectedTargetObject)
    }).subscribe({
      next: ({ sourceData, targetData }) => {
        // Populating target fields
        this.targetFields = targetData.fields || [];

        // Populating live source preview tracking tables
        this.previewHeaders = sourceData.headers || [];
        this.previewRecords = sourceData.sampleRecords || [];

        // Generating dynamic structural mapping topology rows
        this.mappings = (sourceData.fields || []).map((field: FieldMeta) => ({
          sourceField: field.name,
          sourceLabel: field.label,
          targetField: ''
        }));

        this.updateMappedCount();
        this.isLoading = false;

        // <--- CRITICAL FIX: Tell Angular the data has arrived and command an instant redraw
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Metadata payload extraction failed:', err);
        this.logMessages.unshift(`API Error: Unable to fetch live dataset metrics.`);
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  // Toolbar Actions
  clearMapping(index: number) {
    this.mappings[index].targetField = '';
    this.updateMappedCount();
  }

  resetAllMappings() {
    this.mappings.forEach((m) => (m.targetField = ''));
    this.updateMappedCount();
  }

  autoMap() {
    // Dynamic matching based on field name or label similarity
    this.mappings.forEach((m) => {
      const sourceMatchKey = m.sourceField.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = this.targetFields.find((t) => {
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
    this.mappedCount = this.mappings.filter((m) => m.targetField !== '').length;
  }

  runMigration() {
    this.jobStatus = 'Initializing...';
    this.logMessages = [];
    this.cdr.detectChanges();

    const payload = {
      sourceObject: this.selectedSourceObject,
      targetObject: this.selectedTargetObject,
      mappings: this.mappings,
      sfToken: localStorage.getItem('sf_token') || '',
      sfInstance: localStorage.getItem('sf_instance_url') || '',
      zdToken: localStorage.getItem('zd_token') || '',
      zdSubdomain: localStorage.getItem('zd_subdomain') || ''
    };

    const ws = new WebSocket('ws://localhost:8000/ws/migrate');

    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      this.zone.run(() => {
        const data = JSON.parse(event.data);

        this.logMessages = [...this.logMessages, data.log];

        this.jobStatus = data.status;
        this.cdr.detectChanges();

        setTimeout(() => {
          const logContainer = document.querySelector('.bg-dark.overflow-auto');
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
