/* eslint-disable @angular-eslint/prefer-inject */
import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CardComponent } from "src/app/theme/shared/components/card/card.component"; // 1. Fixes ngModel
// import { SharedModule } from '../theme/shared/shared.module'; // 2. Fixes app-card (Adjust this path to where Berry keeps it!)

@Component({
  selector: 'app-start-migration',
  standalone: true, // Confirms this is a standalone component
  imports: [
    FormsModule,
    CardComponent
],
  templateUrl: './start-migration.component.html'
})
export class StartMigrationComponent {
  selectedCrm: string = '';

  crmList = [
    { id: 'ms-dynamics', name: 'Microsoft Dynamics' },
    { id: 'zoho', name: 'Zoho CRM' },
    { id: 'hubspot', name: 'HubSpot' },
    { id: 'other', name: 'Other / Custom CSV' }
  ];

  constructor(private router: Router) {}

  goToMapping() {
    if (this.selectedCrm) {
      this.router.navigate(['/mapping'], { 
        queryParams: { source: this.selectedCrm } 
      });
    }
  }
}