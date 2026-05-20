import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { CrmAuthService } from 'src/app/services/CrmAuthService.service'; 

@Component({
  selector: 'app-connection',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent],
  templateUrl: './connection.component.html',
  styleUrls: ['./connection.component.scss']
})
export class ConnectionComponent implements OnInit {
  
  availableCRMs = [
    { id: 'zendesk', name: 'Zendesk', icon: 'icon-headphones' },
    { id: 'salesforce', name: 'Salesforce', icon: 'icon-cloud' },
    { id: 'hubspot', name: 'HubSpot', icon: 'icon-share-2' },
    { id: 'msdynamics', name: 'MS Dynamics 365', icon: 'icon-cpu' },
    { id: 'zoho', name: 'Zoho CRM', icon: 'icon-layout' }
  ];

  selectedSource: string = '';
  selectedTarget: string = '';
  
  isSourceConnected: boolean = false;
  isTargetConnected: boolean = false;
  
  zendeskSubdomain: string = '';

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private crmAuthService: CrmAuthService 
  ) {}

  ngOnInit() {
    // =========================================================
    // STEP 0: RESTORE SUBDOMAIN (Fix for Zendesk OAuth memory wipe)
    // =========================================================
    const storedSubdomain = localStorage.getItem('zd_subdomain');
    if (storedSubdomain) {
      this.zendeskSubdomain = storedSubdomain;
    }

    // =========================================================
    // STEP 1: RESTORE PREVIOUS CONNECTIONS ON LOAD
    // =========================================================
    const savedSource = localStorage.getItem('source_crm_slot');
    const savedTarget = localStorage.getItem('target_crm_slot');

    if (savedSource && this.hasTokenForCrm(savedSource)) {
      this.selectedSource = savedSource;
      this.isSourceConnected = true;
    }

    if (savedTarget && this.hasTokenForCrm(savedTarget)) {
      this.selectedTarget = savedTarget;
      this.isTargetConnected = true;
    }

    // =========================================================
    // STEP 2: HANDLE NEW INCOMING REDIRECT PARAMETERS
    // =========================================================
  this.route.queryParams.subscribe(params => {
      const side = params['connected_side']; 
      const crm = params['crm'];             
      const token = params['access_token'];
      const instanceUrl = params['instance_url']; // <--- Capture from URL

      if (side && crm) {
        if (side === 'source') {
          this.selectedSource = crm;
          this.isSourceConnected = true;
          localStorage.setItem('source_crm_slot', crm); 
        } else if (side === 'target') {
          this.selectedTarget = crm;
          this.isTargetConnected = true;
          localStorage.setItem('target_crm_slot', crm); 
        }

        if (token) {
          this.crmAuthService.saveConnectionDetails(crm, {
            access_token: token,
            subdomain: this.zendeskSubdomain,
            instance_url: instanceUrl // <--- Pass it to CrmAuthService
          });
        }

        this.router.navigate([], { 
          relativeTo: this.route, 
          queryParams: {}, 
          replaceUrl: true 
        });
      }
    });
  }

  // Helper check method to see if token strings actually reside in storage
  private hasTokenForCrm(crmId: string): boolean {
    const cleanId = crmId.toLowerCase();
    if (cleanId === 'salesforce') return !!localStorage.getItem('sf_token');
    if (cleanId === 'zendesk') return !!localStorage.getItem('zd_token');
    if (cleanId === 'zoho') return !!localStorage.getItem('zoho_token');
    return false;
  }

  getCrmConfig(crmId: string) {
    return this.availableCRMs.find(crm => crm.id === crmId);
  }

  onCrmChange(side: 'source' | 'target') {
    if (side === 'source') {
      this.isSourceConnected = false;
      localStorage.removeItem('source_crm_slot');
    } else {
      this.isTargetConnected = false;
      localStorage.removeItem('target_crm_slot');
    }
  }

  loginToCRM(side: 'source' | 'target') {
    const selectedCrmId = side === 'source' ? this.selectedSource : this.selectedTarget;
    
    if (selectedCrmId === 'zendesk') {
      if (!this.zendeskSubdomain || this.zendeskSubdomain.trim() === '') {
        alert('Please enter your Zendesk subdomain to continue.');
        return;
      }
      // FIX: Save the subdomain to local storage BEFORE leaving the page
      localStorage.setItem('zd_subdomain', this.zendeskSubdomain);
    }

    this.crmAuthService.connectCrm(selectedCrmId, side, this.zendeskSubdomain);
  }

  disconnectCRM(side: 'source' | 'target') {
    const selectedCrmId = side === 'source' ? this.selectedSource : this.selectedTarget;
    
    this.crmAuthService.disconnectCrm(selectedCrmId);

    if (side === 'source') {
      this.isSourceConnected = false;
      this.selectedSource = '';
      localStorage.removeItem('source_crm_slot');
    } else {
      this.isTargetConnected = false;
      this.selectedTarget = '';
      localStorage.removeItem('target_crm_slot');
    }
  }

  goToMappingPage() {
    if (this.isSourceConnected && this.isTargetConnected) {
      this.router.navigate(['/api-mapping'], { 
        state: { 
          sourceCrm: this.selectedSource, 
          targetCrm: this.selectedTarget 
        } 
      }); 
    }
  }
}