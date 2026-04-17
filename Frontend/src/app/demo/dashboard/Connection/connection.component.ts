import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router'; // 1. IMPORT ROUTER
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";

@Component({
  selector: 'app-connection',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent],
  templateUrl: './connection.component.html',
  styleUrls: ['./connection.component.scss']
})
export class ConnectionComponent {
  selectedPlatform: string = '';
  showPassword = false;
  isTesting = false;
  connectionSuccessful = false;
  testMessage = '';

  // Object to hold Dynamics API inputs
  credentials = {
    envUrl: '',
    tenantId: '',
    clientId: '',
    clientSecret: ''
  };

  // 2. INJECT ROUTER INTO THE CONSTRUCTOR
  constructor(private router: Router) {}

  testConnection() {
    this.isTesting = true;
    this.testMessage = '';
    this.connectionSuccessful = false;

    // TODO: Call your actual backend service here. 
    setTimeout(() => {
      // Mocking a successful response after 1.5 seconds
      this.isTesting = false;
      this.connectionSuccessful = true;
      this.testMessage = 'Connection successful! Your API keys are valid.';
    }, 1500);
  }

  testAndSaveConnection() {
    this.router.navigate(['/api-mapping']); 
    if (this.connectionSuccessful) {
      // TODO: Save to database or state management
      console.log('Saving credentials payload: ', this.credentials);
      
      // 3. NAVIGATE TO THE MAPPING COMPONENT
      // Ensure this path exactly matches the path in your routing module
      this.router.navigate(['/api-mapping']); 
    }
  }

  resetForm() {
    this.selectedPlatform = '';
    this.connectionSuccessful = false;
    this.testMessage = '';
    this.credentials = { envUrl: '', tenantId: '', clientId: '', clientSecret: '' };
  }
}