/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @angular-eslint/prefer-inject */
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { MigrationService } from '../services/migration.service';

@Component({
  selector: 'app-migration-tool',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './migration-tool.html',
  styleUrls: ['./migration-tool.scss']
})
export class MigrationTool implements OnInit {
  currentStep: number = 1;

  // Step 1: Source CRM
  selectedCRM: string = '';

  // Step 2: File Selection & SF Object
  selectedFile: File | null = null;
  sfObjects: any[] = [];
  selectedObject: string = '';

  // Step 3: Mapping
  csvHeaders: string[] = [];
  sfFields: any[] = [];
  mappings: { zohoField: string, sfField: string }[] = [];

  loading: boolean = false;
  migrationResults: any = null;

  constructor(private migrationService: MigrationService) {}

 ngOnInit() {
  // Call this immediately so the "Select Object" list is ready
  this.migrationService.getSFObjects().subscribe({
    next: (data) => {
      this.sfObjects = data; // Populates your dropdown
      console.log('SF Objects Loaded:', data);
    },
    error: (err) => console.error('Failed to load objects', err)
  });
}

onObjectChange() {
  if (this.selectedObject) {
    this.loading = true;
    this.migrationService.getSFFields(this.selectedObject).subscribe({
      next: (fields) => {
        this.sfFields = fields;
        // This generates your mapping table rows
        this.mappings = this.csvHeaders.map(h => ({ zohoField: h, sfField: '' }));
        this.loading = false;
      },
      error: () => this.loading = false
    });
  }
}

  // --- Step 1 ---
  onCRMSelect(crm: string) {
    this.selectedCRM = crm;
    this.currentStep = 2;
  }

  // --- Step 2 ---
  onFileSelected(event: any) {
    this.selectedFile = event.target.files[0];
    if (this.selectedFile) {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        const firstLine = e.target.result.split('\n')[0];
        this.csvHeaders = firstLine.split(',').map((h: string) => h.trim().replace(/"/g, ''));
      };
      reader.readAsText(this.selectedFile);
    }
  }

  onObjectSelect() {
    if (this.selectedObject) {
      this.migrationService.getSFFields(this.selectedObject).subscribe(fields => {
        this.sfFields = fields;
        // Pre-fill mapping rows based on CSV headers
        this.mappings = this.csvHeaders.map(h => ({ zohoField: h, sfField: '' }));
      });
    }
  }

  goToMapping() {
    if (this.selectedObject && this.selectedFile) this.currentStep = 3;
  }

  // --- Step 3 ---
  startMigration() {
    this.loading = true;

    // Transform array to object for backend: { "Zoho_Col": "SF_Field" }
    const mappingObj: any = {};
    this.mappings.forEach(m => {
      if (m.sfField) mappingObj[m.zohoField] = m.sfField;
    });

    const payload = {
      operation: 'insert',
      objectName: this.selectedObject,
      mappings: mappingObj
    };

    this.migrationService.uploadData(this.selectedFile!, payload).subscribe({
      next: (res) => {
        this.loading = false;
        this.migrationResults = res.data;
        this.currentStep = 4;
      },
      error: (err) => {
        this.loading = false;
        alert("Migration failed: " + err.message);
      }
    });
  }
}
