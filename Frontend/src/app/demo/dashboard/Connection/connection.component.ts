import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { CrmAuthService, CrmConnection } from 'src/app/services/CrmAuthService.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'app-connection',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent],
  templateUrl: './connection.component.html',
  styleUrls: ['./connection.component.scss']
})
export class ConnectionComponent implements OnInit {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private crmAuthService = inject(CrmAuthService);
  private toastr = inject(ToastrService);

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

  sourceInstanceUrl: string = '';
  targetInstanceUrl: string = '';

  // Fully isolated variables for Source
  sourceZendeskSubdomain: string = '';
  sourceZohoRegion: string = 'IN';
  sourceSalesforceEnv: string = 'production';

  // Fully isolated variables for Target
  targetZendeskSubdomain: string = '';
  targetZohoRegion: string = 'IN';
  targetSalesforceEnv: string = 'production';

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      const status = params['status'];
      const side = params['side']; 
      const crm = params['crm'];   

      if (status === 'success') {
        this.toastr.success(`${crm ? crm.toUpperCase() : 'CRM'} Connected Successfully!`);
        
        if (side === 'source' && crm) {
          this.selectedSource = crm;
          this.isSourceConnected = true;
        } else if (side === 'target' && crm) {
          this.selectedTarget = crm;
          this.isTargetConnected = true;
        }

        this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
      } else if (status === 'error') {
        this.toastr.error('Failed to connect to CRM. Please try again.');
        this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
      }
      
      this.loadActiveConnections();
    });
  }

  loadActiveConnections() {
    this.crmAuthService.getUserConnections().subscribe({
      next: (connections: CrmConnection[]) => {
        this.isSourceConnected = false;
        this.isTargetConnected = false;
        this.sourceInstanceUrl = ''; 
        this.targetInstanceUrl = ''; 

        connections.forEach(conn => {
          if (conn.connection_role === 'source') {
            this.selectedSource = conn.crm_type;
            this.isSourceConnected = true;
            this.sourceInstanceUrl = conn.instance_url || ''; 
            if (conn.crm_type === 'zendesk' && conn.subdomain) this.sourceZendeskSubdomain = conn.subdomain;
            if (conn.crm_type === 'zoho' && conn.region) this.sourceZohoRegion = conn.region;
            if (conn.crm_type === 'salesforce' && conn.environment) this.sourceSalesforceEnv = conn.environment;
          } 
          else if (conn.connection_role === 'target') {
            this.selectedTarget = conn.crm_type;
            this.isTargetConnected = true;
            this.targetInstanceUrl = conn.instance_url || ''; 
            if (conn.crm_type === 'zendesk' && conn.subdomain) this.targetZendeskSubdomain = conn.subdomain;
            if (conn.crm_type === 'zoho' && conn.region) this.targetZohoRegion = conn.region;
            if (conn.crm_type === 'salesforce' && conn.environment) this.targetSalesforceEnv = conn.environment;
          }
        });
      },
      error: (err) => {
        console.error('Failed to load CRM connections', err);
        this.toastr.error('Could not load your saved connections.');
      }
    });
  }

  getCrmConfig(crmId: string) {
    return this.availableCRMs.find(crm => crm.id === crmId);
  }

  onCrmChange(side: 'source' | 'target') {
    if (side === 'source') {
      this.isSourceConnected = false;
    } else {
      this.isTargetConnected = false;
    }
  }

  loginToCRM(side: 'source' | 'target') {
    const selectedCrmId = side === 'source' ? this.selectedSource : this.selectedTarget;

    const subdomain = side === 'source' ? this.sourceZendeskSubdomain : this.targetZendeskSubdomain;
    const region = side === 'source' ? this.sourceZohoRegion : this.targetZohoRegion;
    const env = side === 'source' ? this.sourceSalesforceEnv : this.targetSalesforceEnv;

    if (selectedCrmId === 'zendesk' && (!subdomain || subdomain.trim() === '')) {
      this.toastr.warning(`Please enter your ${side} Zendesk subdomain to continue.`);
      return;
    }

    this.crmAuthService.connectCrm(selectedCrmId, side, subdomain, region, env);
  }

  disconnectCRM(side: 'source' | 'target') {
    this.crmAuthService.disconnectCrm(side).subscribe({
      next: () => {
        this.toastr.success('Disconnected successfully.');
        if (side === 'source') {
          this.isSourceConnected = false;
          this.selectedSource = '';
          this.sourceZendeskSubdomain = '';
        } else {
          this.isTargetConnected = false;
          this.selectedTarget = '';
          this.targetZendeskSubdomain = '';
        }
      },
      error: () => {
        this.toastr.error('Failed to disconnect. Please try again.');
      }
    });
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