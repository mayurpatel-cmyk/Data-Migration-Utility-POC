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

  zendeskSubdomain: string = '';
  zohoRegion: string = 'IN';

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      // 1. Instantly restore the UI if the URL tells us what just connected
      const status = params['status'];
      const side = params['side']; // e.g., 'source' or 'target'
      const crm = params['crm'];   // e.g., 'salesforce'

      if (status === 'success') {
        this.toastr.success(`${crm ? crm.toUpperCase() : 'CRM'} Connected Successfully!`);
        
        // Instantly update the dropdowns so the screen doesn't flicker/clear
        if (side === 'source' && crm) {
          this.selectedSource = crm;
          this.isSourceConnected = true;
        } else if (side === 'target' && crm) {
          this.selectedTarget = crm;
          this.isTargetConnected = true;
        }

        // Clean up the URL so it looks nice
        this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
      } else if (status === 'error') {
        this.toastr.error('Failed to connect to CRM. Please try again.');
        this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
      }
      
      // 2. Always fetch the absolute truth from the database in the background
      //this.loadActiveConnections();
    });
  }

  loadActiveConnections() {
    this.crmAuthService.getUserConnections().subscribe({
      next: (connections: CrmConnection[]) => {
        // Reset state
        this.isSourceConnected = false;
        this.isTargetConnected = false;

        // Apply database state to UI
        connections.forEach(conn => {
          if (conn.connection_role === 'source') {
            this.selectedSource = conn.crm_type;
            this.isSourceConnected = true;
            if (conn.crm_type === 'zendesk' && conn.subdomain) this.zendeskSubdomain = conn.subdomain;
            if (conn.crm_type === 'zoho' && conn.region) this.zohoRegion = conn.region;
          } 
          else if (conn.connection_role === 'target') {
            this.selectedTarget = conn.crm_type;
            this.isTargetConnected = true;
            if (conn.crm_type === 'zendesk' && conn.subdomain) this.zendeskSubdomain = conn.subdomain;
            if (conn.crm_type === 'zoho' && conn.region) this.zohoRegion = conn.region;
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

    if (selectedCrmId === 'zendesk' && (!this.zendeskSubdomain || this.zendeskSubdomain.trim() === '')) {
      this.toastr.warning('Please enter your Zendesk subdomain to continue.');
      return;
    }

    // Call the updated service method. 
    // It will grab the token, get the URL from the backend, and force the redirect automatically!
    this.crmAuthService.connectCrm(selectedCrmId, side, this.zendeskSubdomain, this.zohoRegion);
  }

  disconnectCRM(side: 'source' | 'target') {
    this.crmAuthService.disconnectCrm(side).subscribe({
      next: () => {
        this.toastr.success('Disconnected successfully.');
        if (side === 'source') {
          this.isSourceConnected = false;
          this.selectedSource = '';
        } else {
          this.isTargetConnected = false;
          this.selectedTarget = '';
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