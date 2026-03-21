/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook } from 'xlsx';

// Project Import
import { CardComponent } from "src/app/theme/shared/components/card/card.component";
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { MigrationService } from 'src/app/services/migration.service';

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

  // Step 1 State
  currentStep: number = 1;
  selectedCRM: string = '';

  // Step 2 State
  selectedFile: File | null = null;
  selectedObject: string = '';
  csvHeaders: string[] = [];
  sfObjects: any[] = []; 
  isLoadingObjects = false;

  // --- NEW EXCEL/MULTI-SHEET STATE ---
  workbook: WorkBook | null = null;
  availableSheets: string[] = [];
  selectedSheetName: string = '';

  // Step 3 State
  sfFields: any[] = []; 
  mappings: { csvField: string, sfField: string }[] = [];
  isLoadingFields = false;

  ngOnInit() {
    this.isLoadingObjects = true;
    this.migrationService.getAllObjects().subscribe({
      next: (objects) => {
        this.sfObjects = objects;
        this.isLoadingObjects = false;
      },
      error: (err) => {
        console.error('Failed to load objects:', err);
        this.isLoadingObjects = false;
      }
    });
  }

  onCRMSelect(crm: string) {
    this.selectedCRM = crm;
    if (this.currentStep === 1) this.currentStep = 2;
  }

  // --- UPGRADED FILE HANDLER ---
  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.selectedFile = file;
      const reader = new FileReader();
      
      // We read it as an ArrayBuffer so SheetJS can decode Excel files
      reader.onload = (e: any) => {
        const data = new Uint8Array(e.target.result);
        
        // Read the workbook (works for BOTH .csv and .xlsx)
        this.workbook = read(data, { type: 'array' });
        
        // Extract the sheet names (CSVs will just have one sheet named "Sheet1" or the filename)
        this.availableSheets = this.workbook.SheetNames;
        
        if (this.availableSheets.length === 1) {
          // If it's a CSV or single-sheet Excel, auto-select the first sheet
          this.onSheetSelect(this.availableSheets[0]);
        } else {
          // If it has multiple sheets, reset headers until the user picks one
          this.selectedSheetName = '';
          this.csvHeaders = [];
        }
        
        this.cdr.detectChanges();
      };
      reader.readAsArrayBuffer(this.selectedFile);
    } else {
      this.selectedFile = null;
      this.csvHeaders = [];
      this.availableSheets = [];
    }
  }

  // --- NEW METHOD: Extract headers when a specific sheet is chosen ---
  onSheetSelect(sheetName: string) {
    this.selectedSheetName = sheetName;
    if (this.workbook) {
      const worksheet = this.workbook.Sheets[sheetName];
      
      // Convert the first row of that specific sheet into a JSON array
      const json: any[][] = utils.sheet_to_json(worksheet, { header: 1 });
      
      if (json.length > 0) {
        // Grab the first row (the headers) and clean them up
        this.csvHeaders = json[0]
          .map((h: any) => h ? String(h).trim() : '')
          .filter((h: string) => h.length > 0);
          
        console.log(`✅ Headers extracted from sheet "${sheetName}":`, this.csvHeaders);
      } else {
        this.csvHeaders = [];
        alert(`Warning: Sheet "${sheetName}" appears to be empty.`);
      }
    }
  }

  goToMapping() {
    if (this.csvHeaders.length === 0) {
      alert('Cannot map fields: Your file appears to be empty or unreadable.');
      return;
    }

    if (this.selectedFile && this.selectedObject) {
      this.currentStep = 3;
      this.isLoadingFields = true;

      this.mappings = this.csvHeaders.map(header => ({
        csvField: header,
        sfField: '' 
      }));

      this.migrationService.getObjectFields(this.selectedObject).subscribe({
        next: (response: any) => {
          const fieldsArray = response.fields ? response.fields : response;
          this.sfFields = Array.isArray(fieldsArray) ? fieldsArray : [];
          this.isLoadingFields = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Failed to load fields:', err);
          this.isLoadingFields = false;
          this.cdr.detectChanges();
        }
      });
    }
  }

  startMigration() {
    const activeMappings = this.mappings.filter(m => m.sfField !== '');
    const payload = {
      sourceCrm: this.selectedCRM,
      targetObject: this.selectedObject,
      sheetName: this.selectedSheetName, // Let the backend know which sheet was mapped!
      fieldMapping: activeMappings
    };

    console.log('🚀 READY TO MIGRATE!', payload);
  }
}