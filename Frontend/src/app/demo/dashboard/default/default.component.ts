/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook } from 'xlsx';
import { CardComponent } from "src/app/theme/shared/components/card/card.component";
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { MigrationService } from 'src/app/services/migration.service';
import { ToastrService } from 'ngx-toastr';

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
  private toastr = inject(ToastrService); // <-- 2. Inject ToastrService

  currentStep: number = 1;
  selectedCRM: string = '';

  selectedFile: File | null = null;
  selectedObject: string = '';
  csvHeaders: string[] = [];
  sfObjects: any[] = []; 
  isLoadingObjects = false;

  workbook: WorkBook | null = null;
  availableSheets: string[] = [];
  selectedSheetName: string = '';

  sfFields: any[] = []; 
  mappings: { csvField: string, sfField: string }[] = [];
  isLoadingFields = false;
  isMigrating = false;

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
        this.toastr.error('Could not load Salesforce objects.', 'Connection Error');
      }
    });
  }

  onCRMSelect(crm: string) {
    this.selectedCRM = crm;
    if (this.currentStep === 1) this.currentStep = 2;
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
        
        this.cdr.detectChanges();
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
        this.csvHeaders = json[0]
          .map((h: any) => h ? String(h).trim() : '')
          .filter((h: string) => h.length > 0);
          
        console.log(`✅ Headers extracted from sheet "${sheetName}":`, this.csvHeaders);
      } else {
        this.csvHeaders = [];
        this.toastr.warning(`Sheet "${sheetName}" appears to be empty.`, 'Empty Data');
      }
    }
  }

  goToMapping() {
    if (this.csvHeaders.length === 0) {
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
          this.toastr.error('Failed to load object fields.', 'API Error');
        }
      });
    }
  }

  startMigration() {
    const activeMappings = this.mappings.filter(m => m.sfField !== '');
    
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field before migrating.', 'No Mappings');
      return;
    }

    this.isMigrating = true;

    const worksheet = this.workbook!.Sheets[this.selectedSheetName];
    const rawData: any[] = utils.sheet_to_json(worksheet); 

    const sfRecords = rawData.map(rawRow => {
      const sfRecord: any = {};
      
      activeMappings.forEach(mapping => {
        if (rawRow[mapping.csvField] !== undefined && rawRow[mapping.csvField] !== null) {
          sfRecord[mapping.sfField] = rawRow[mapping.csvField];
        }
      });
      
      return sfRecord;
    });

    const payload = {
      targetObject: this.selectedObject,
      records: sfRecords
    };

    this.migrationService.migrateData(payload).subscribe({
      next: (response) => {
        this.isMigrating = false;
        const msg = `Successfully inserted ${response.stats?.success} records. Failed: ${response.stats?.failed}`;
        this.toastr.success(msg, 'Migration Complete!');
      },
      error: (err) => {
        this.isMigrating = false;
        const errMsg = err.error?.message || 'Check console for details';
        this.toastr.error(errMsg, 'Migration Failed');
      }
    });
  }
}