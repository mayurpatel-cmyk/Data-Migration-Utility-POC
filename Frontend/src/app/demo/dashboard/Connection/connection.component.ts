import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
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

  // Expanded object to hold API inputs for various platforms
  credentials = {
    envUrl: '',       // Used for Dynamics Env, Salesforce Instance, Zoho Domain, Zendesk Subdomain
    tenantId: '',     // Used for Dynamics
    clientId: '',     // Used for Dynamics, Salesforce, Zoho
    clientSecret: '', // Used for Dynamics, Salesforce, Zoho
    accessToken: '',  // Used for HubSpot PAT, Zendesk API Token
    username: ''      // Used for Zendesk Email
  };

  constructor(private router: Router) {}

  testConnection() {
    this.isTesting = true;
    this.testMessage = '';
    this.connectionSuccessful = false;

    // TODO: Call your actual backend service here. Depending on the `selectedPlatform`, 
    // you will pass different properties from the `credentials` object.
    setTimeout(() => {
      // Mocking a successful response after 1.5 seconds
      this.isTesting = false;
      this.connectionSuccessful = true;
      this.testMessage = `Connection to ${this.selectedPlatform} successful! Your API keys are valid.`;
    }, 1500);
  }

  testAndSaveConnection() {
    if (this.connectionSuccessful) {
      // TODO: Save to database or state management
      console.log(`Saving ${this.selectedPlatform} credentials payload: `, this.credentials);
      
      // NAVIGATE TO THE MAPPING COMPONENT
      this.router.navigate(['/api-mapping']); 
    } else {
      this.testMessage = 'Please test the connection successfully before saving.';
    }
  }

  resetForm() {
    this.selectedPlatform = '';
    this.connectionSuccessful = false;
    this.testMessage = '';
    this.showPassword = false;
    
    // Reset all potential credential fields
    this.credentials = { 
      envUrl: '', 
      tenantId: '', 
      clientId: '', 
      clientSecret: '',
      accessToken: '',
      username: ''
    };
  }
}