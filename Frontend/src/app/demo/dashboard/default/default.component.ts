/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { read, utils, WorkBook } from 'xlsx';
import { CardComponent } from "src/app/theme/shared/components/card/card.component";
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { MigrationService } from 'src/app/services/migration.service';
import { ToastrService } from 'ngx-toastr';
import { firstValueFrom } from 'rxjs'; // For handling loop-based observables

// New Interface for the Queue
interface QueuedMigration {
  objectName: string;
  sheetName: string;
  mappings: { csvField: string, sfField: string }[];
  previewData: any[];
}

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
  confirmedMappings: { csvField: string, sfField: string }[] = [];
  isLoadingFields = false;
  isMigrating = false;
  migrationSummary: any = null;
  failedRecords: any[] = []; // To store { record: any, error: string }
  successfulRecords: any[] = []; // To store successfully migrated records for review
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
    setTimeout(() => {
    this.currentStep = 2;
    this.autoNavigate(); // This pulls Step 2 into view automatically
    this.cdr.detectChanges();
  }, 300);
    // if (this.currentStep === 1) {
    //   this.currentStep = 2;
    //   this.autoNavigate();
    // }
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
      } else {
        this.csvHeaders = [];
        this.toastr.warning(`Sheet "${sheetName}" is empty.`, 'Empty Data');
      }
    }
  }

  goToMapping() {
    if (this.csvHeaders.length === 0) return;
    if (this.selectedFile && this.selectedObject) {
      this.currentStep = 3;
      this.autoNavigate();
      this.isLoadingFields = true;
      this.mappings = this.csvHeaders.map(header => ({ csvField: header, sfField: '' }));
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
          this.isLoadingFields = false;
          this.toastr.error('Failed to load fields.', 'API Error');
        }
      });
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

  goToReview() {
    // Filter only the fields that were actually mapped
    this.confirmedMappings = this.mappings.filter(m => m.sfField && m.sfField !== '');

    if (this.confirmedMappings.length === 0) {
      this.toastr.warning('Please map at least one field before proceeding.', 'Mapping Required');
      return;
    }

    this.currentStep = 4;
    this.autoNavigate();
    this.cdr.detectChanges();

  }

 startMigration() {
    this.showPreview = false; // Hide preview table while migrating

    const activeMappings = this.mappings.filter(m => m.sfField !== '');
    if (activeMappings.length === 0) {
      this.toastr.warning('Please map at least one field.', 'Mapping Required');
      return;
    }

    // Generate specific preview for this queued object
    const worksheet = this.workbook!.Sheets[this.selectedSheetName];
    const rawData: any[] = utils.sheet_to_json(worksheet);
    const previewRows = rawData.slice(0, 3).map(rawRow => {
      const record: any = {};
      activeMappings.forEach(m => {
        if (rawRow[m.csvField] != null) record[m.sfField] = rawRow[m.csvField];
      });
      return record;
    });

    this.migrationQueue.push({
      objectName: this.selectedObject,
      sheetName: this.selectedSheetName,
      mappings: [...activeMappings],
      previewData: previewRows
    });

    this.toastr.success(`${this.selectedObject} added to queue.`, 'Object Queued');
    
    // Reset for next object
    this.selectedObject = '';
    this.mappings = [];
    this.currentStep = 2; // Go back to step 2 to select another object
    this.autoNavigate();
  }

  goToReview() {
    if (this.migrationQueue.length === 0) {
      // If user forgot to click "Add to Queue", try to add the current mapping first
      const active = this.mappings.filter(m => m.sfField !== '');
      if (active.length > 0) {
        this.addToQueue();
      } else {
        this.toastr.warning('Please add at least one object mapping to the queue.', 'Empty Queue');
        return;
      }
    }
    this.currentStep = 4;
    this.autoNavigate();
    this.cdr.detectChanges();
  }

  async startMigration() {
    this.isMigrating = true;
    this.migrationSummary = { success: 0, failed: 0 };
    this.failedRecords = [];
    this.successfulRecords = [];
    this.cdr.detectChanges();

    // Loop through each queued object and send to server
    for (const job of this.migrationQueue) {
      try {
        const worksheet = this.workbook!.Sheets[job.sheetName];
        const rawData: any[] = utils.sheet_to_json(worksheet);
        const sfRecords = rawData.map(rawRow => {
          const sfRecord: any = {};

          // activeMappings.forEach(mapping => {
          //   if (rawRow[mapping.csvField] !== undefined && rawRow[mapping.csvField] !== null) {
          //     sfRecord[mapping.sfField] = rawRow[mapping.csvField];
          //   }
          // });
          this.confirmedMappings.forEach(mapping => {
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
            console.log('Migration response from server:', response);
            this.isMigrating = false;

            // 2. Calculate stats
            const successCount = response.stats?.success || 0;
            const failedCount = response.stats?.failed || 0;
            this.migrationSummary = response.stats;
            this.failedRecords = response.failures || [];
            this.successfulRecords = response.successfulRecords || [];
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
            this.currentStep = 5;
            this.autoNavigate();
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
        this.toastr.error(`Failed to migrate ${job.objectName}`, 'Queue Error');
      }
    }

    this.isMigrating = false;
    this.currentStep = 5;
    this.autoNavigate();
    this.cdr.detectChanges();
  }

  removeFromQueue(index: number) {
    this.migrationQueue.splice(index, 1);
  }

  // --- EXISTING LOGIC ---
  downloadSuccessLog() {
    const worksheet = utils.json_to_sheet(this.successfulRecords);
    const csvOutput = utils.sheet_to_csv(worksheet);
    this.saveAsCsv(csvOutput, 'success_log');
  }

  downloadErrorLog() {
    const report = this.failedRecords.map(f => ({ Error: f.error, ...f.record }));
    const worksheet = utils.json_to_sheet(report);
    const csvOutput = utils.sheet_to_csv(worksheet);
    this.saveAsCsv(csvOutput, 'error_log');
  }

  private saveAsCsv(buffer: string, fileName: string) {
    const data = new Blob([buffer], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(data);
    link.download = `${fileName}_${new Date().getTime()}.csv`;
    link.click();
  }

  private autoNavigate() {
    setTimeout(() => {
      const element = document.querySelector('.row.mb-4:last-of-type');
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
      }
    }, 100);
  }
 downloadSuccessLog() {
  const worksheet = utils.json_to_sheet(this.successfulRecords);
  const csvOutput = utils.sheet_to_csv(worksheet);
  this.saveAsCsv(csvOutput, 'success_log');
}

downloadErrorLog() {
  // We transform the failedRecords array to make the CSV readable
  const report = this.failedRecords.map(f => ({
    Error: f.error,
    ...f.record
  }));

  const worksheet = utils.json_to_sheet(report);
  const csvOutput = utils.sheet_to_csv(worksheet);
  this.saveAsCsv(csvOutput, 'error_log');
}

// Helper to trigger the browser download
private saveAsCsv(buffer: string, fileName: string) {
  const data = new Blob([buffer], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = window.URL.createObjectURL(data);
  link.download = `${fileName}_${new Date().getTime()}.csv`;
  link.click();
}

private autoNavigate() {
  // We wait 100ms for Angular's @if to actually put the new HTML on the screen
  setTimeout(() => {
    // We look for the "active" row (the one that just appeared)
    const element = document.querySelector('.row.mb-4:last-of-type');
    if (element) {
      element.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest'
      });
    }
  }, 100);
}

}


