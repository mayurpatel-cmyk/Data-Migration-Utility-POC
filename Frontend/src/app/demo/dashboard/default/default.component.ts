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
  private toastr = inject(ToastrService);

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

  // --- PREVIEW STATE ---
  previewData: any[] = [];
  showPreview = false;

  ngOnInit() {
    this.isLoadingObjects = true;
    this.migrationService.getAllObjects().subscribe({
      next: (objects) => {
        this.sfObjects = objects;
        setTimeout(() => this.isLoadingObjects = false);
      },
      error: (err) => {
        console.error('Failed to load objects:', err);
        setTimeout(() => this.isLoadingObjects = false);
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

        setTimeout(() => this.cdr.detectChanges());
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

        console.log(`Headers extracted from sheet "${sheetName}":`, this.csvHeaders);
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
          setTimeout(() => {
            this.isLoadingFields = false;
            this.cdr.detectChanges();
          });
        },
        error: (err) => {
          console.error('Failed to load fields:', err);
          setTimeout(() => {
            this.isLoadingFields = false;
            this.cdr.detectChanges();
            this.toastr.error('Failed to load object fields.', 'API Error');
          });
        }
      }); // <-- ALL BRACKETS FIXED HERE
    }
  }

  // generatePreview() {
  //   const activeMappings = this.mappings.filter(m => m.sfField !== '');

  //   if (activeMappings.length === 0) {
  //     this.toastr.warning('Please map at least one field to generate a preview.', 'No Mappings');
  //     return;
  //   }

  //   const worksheet = this.workbook!.Sheets[this.selectedSheetName];
  //   const rawData: any[] = utils.sheet_to_json(worksheet); 

  //   // Transform ONLY the first 5 rows for the preview
  //   const limit = Math.min(rawData.length, 5);
  //   const previewRows = [];

  //   for (let i = 0; i < limit; i++) {
  //     const rawRow = rawData[i];
  //     const sfRecord: any = {};

  //     activeMappings.forEach(mapping => {
  //       if (rawRow[mapping.csvField] !== undefined && rawRow[mapping.csvField] !== null) {
  //         // Use the mapped Salesforce field name as the key
  //         sfRecord[mapping.sfField] = rawRow[mapping.csvField];
  //       }
  //     });

  //     previewRows.push(sfRecord);
  //   }

  //   this.previewData = previewRows;
  //   this.showPreview = true;
  //   this.toastr.info('Preview generated! Check below the mapping table.', 'Preview Ready');
  // }

 startMigration() {
    this.showPreview = false; // Hide preview table while migrating

    const activeMappings = this.mappings.filter(m => m.sfField !== '');

    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field before migrating.', 'No Mappings');
      return;
    }

    // 1. Instantly turn on the spinner
    this.isMigrating = true;
    this.cdr.detectChanges(); // Tell Angular to draw the spinner right NOW

    // 2. Push the heavy Excel crunching to the background (next browser tick)
    // This stops the NG0100 error and prevents the browser from freezing!
    setTimeout(() => {
      try {
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

        // 3. Send the data to the backend
       // 3. Send the data to the backend
        this.migrationService.migrateData(payload).subscribe({
          next: (response) => {
            // 1. Turn off the loading spinner
            this.isMigrating = false;
            
            // 2. Calculate stats
            const successCount = response.stats?.success || 0;
            const failedCount = response.stats?.failed || 0;
            const msg = `Successfully inserted ${successCount} records. Failed: ${failedCount}`;

            // 3. Check the stats to determine which toast to show
            if (successCount > 0 && failedCount === 0) {
              // 100% Success
              this.toastr.success(msg, 'Migration Complete!');
            } else if (successCount > 0 && failedCount > 0) {
              // Partial Success (Some worked, some failed)
              this.toastr.warning(msg, 'Partial Migration');
            } else {
              // 100% Failure (Salesforce rejected everything)
              this.toastr.error(`${msg}. Check required fields!`, 'Migration Failed');
            }

            // 4. Safely tell Angular to update the screen (stops the spinner)
            this.cdr.detectChanges(); 
          },
          error: (err) => {
            this.isMigrating = false;
            const errMsg = err.error?.message || 'Check console for details';
            this.toastr.error(errMsg, 'Server Error');
            
            // Safely tell Angular to update the screen
            this.cdr.detectChanges(); 
          }
        });

      } catch (error) {
        // Catch any weird Excel parsing errors safely
        this.isMigrating = false;
        this.toastr.error('Failed to read data from the file.', 'Parsing Error');
        this.cdr.detectChanges();
      }
    }, 10); // 10ms delay is imperceptible to the user, but a lifetime for Angular!
  }
}