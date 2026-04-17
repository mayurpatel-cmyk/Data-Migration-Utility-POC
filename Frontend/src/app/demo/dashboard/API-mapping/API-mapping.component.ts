import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";

interface FieldMeta {
  name: string;
  label: string;
}

interface MappingRow {
  sourceField: string;
  sourceLabel: string;
  targetField: string;
}

@Component({
  selector: 'app-api-mapping',
    standalone: true,
  // 2. Add it to the component's imports array
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent],
  templateUrl: './API-mapping.component.html',
  styleUrls: ['./API-mapping.component.scss']
})
export class ApiMappingComponent implements OnInit {
  
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

  ngOnInit(): void {}

  // Triggers when object dropdowns change
  loadMetadata() {
    if (!this.selectedSourceObject || !this.selectedTargetObject) return;

    this.isLoading = true;
    
    setTimeout(() => {
      // 1. Mock Salesforce Target Fields
      this.targetFields = [
        { name: 'Id', label: 'Record ID' },
        { name: 'Name', label: 'Account Name' },
        { name: 'Phone', label: 'Phone' },
        { name: 'Website', label: 'Website' },
        { name: 'Dynamics_Id__c', label: 'Dynamics Ext ID' }
      ];

      // 2. Mock Source Data for the Preview Table (Left Pane)
      this.previewHeaders = ['accountid', 'name', 'telephone1', 'websiteurl'];
      this.previewRecords = [
        { accountid: '001A-839X', name: 'Sample Account for Ent.', telephone1: '555-0192', websiteurl: 'www.sample.com' },
        { accountid: '002B-481Y', name: 'Edge Communications', telephone1: '555-0193', websiteurl: 'www.edge.com' },
        { accountid: '003C-932Z', name: 'Burlington Textiles', telephone1: '555-0194', websiteurl: 'www.burlington.com' },
        { accountid: '004D-111A', name: 'Pyramid Construction', telephone1: '555-0195', websiteurl: 'www.pyramid.com' },
        { accountid: '005E-222B', name: 'Dickenson plc', telephone1: '555-0196', websiteurl: 'www.dickenson.com' }
      ];

      // 3. Initialize Mapping Rows (Right Pane)
      this.mappings = [
        { sourceField: 'accountid', sourceLabel: 'Account ID', targetField: '' },
        { sourceField: 'name', sourceLabel: 'Company Name', targetField: '' },
        { sourceField: 'telephone1', sourceLabel: 'Main Phone', targetField: '' },
        { sourceField: 'websiteurl', sourceLabel: 'Website URL', targetField: '' },
        { sourceField: 'address1_city', sourceLabel: 'City', targetField: '' },
        { sourceField: 'statecode', sourceLabel: 'Status Code', targetField: '' }
      ];

      this.updateMappedCount();
      this.isLoading = false;
    }, 800);
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
    this.mappings.forEach(m => {
      if (m.sourceField === 'name') m.targetField = 'Name';
      if (m.sourceField === 'telephone1') m.targetField = 'Phone';
      if (m.sourceField === 'websiteurl') m.targetField = 'Website';
      if (m.sourceField === 'accountid') m.targetField = 'Dynamics_Id__c';
    });
    this.updateMappedCount();
    this.logMessages.unshift('System: Auto-mapping applied based on field similarity.');
  }

  updateMappedCount() {
    this.mappedCount = this.mappings.filter(m => m.targetField !== '').length;
  }

  // Execution Bottom Panel
  runMigration() {
    this.jobStatus = 'Running...';
    this.logMessages = [
      'Initializing API connection to Salesforce...',
      'Compiling mapping schema...',
      'Fetching batch 1 from Dynamics (200 records)...'
    ];

    setTimeout(() => {
      this.logMessages.unshift('Batch 1 successfully upserted to Salesforce.');
      this.logMessages.unshift('Job Complete: 200 records processed.');
      this.jobStatus = 'Completed';
    }, 2000);
  }
}