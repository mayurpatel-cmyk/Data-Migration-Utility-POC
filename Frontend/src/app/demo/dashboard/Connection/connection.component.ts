import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';
import { BreadcrumbComponent } from "src/app/theme/shared/components/breadcrumbs/breadcrumbs.component";
import { CrmAuthService, CrmConnection } from 'src/app/services/CrmAuthService.service';
import { ToastrService } from 'ngx-toastr';
import { Subscription, switchMap, delay } from 'rxjs';

@Component({
  selector: 'app-connection',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent, BreadcrumbComponent],
  templateUrl: './connection.component.html',
  styleUrls: ['./connection.component.scss']
})
export class ConnectionComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private crmAuthService = inject(CrmAuthService);
  private toastr = inject(ToastrService);
  private cdr = inject(ChangeDetectorRef);

  private authSubscription!: Subscription;

  availableCRMs = [
    { id: 'zendesk', name: 'Zendesk', icon: 'icon-headphones' },
    { id: 'salesforce', name: 'Salesforce', icon: 'icon-cloud' },
    { id: 'hubspot', name: 'HubSpot', icon: 'icon-share-2' },
   // { id: 'msdynamics', name: 'MS Dynamics 365', icon: 'icon-cpu' },
    { id: 'zoho', name: 'Zoho CRM', icon: 'icon-layout' }
  ];

  selectedSource: string = '';
  selectedTarget: string = '';

  isSourceConnected: boolean = false;
  isTargetConnected: boolean = false;

  sourceInstanceUrl: string = '';
  targetInstanceUrl: string = '';

  // Source isolated states
  sourceZendeskSubdomain: string = '';
  sourceZohoRegion: string = 'IN';
  sourceSalesforceEnv: string = 'production';

  // Target isolated states
  targetZendeskSubdomain: string = '';
  targetZohoRegion: string = 'IN';
  targetSalesforceEnv: string = 'production';

  showPathSelection: boolean = false;
  isPageLoading: boolean = true;
  isSourceConnecting: boolean = false;
  isTargetConnecting: boolean = false;

  ngOnInit() {
    this.isPageLoading = true; // Start loading immediately

    this.authSubscription = this.route.queryParams.pipe(
      switchMap(params => {
        const status = params['status'];
        const crm = params['crm'];   

        if (status === 'success') {
          this.toastr.success(`${crm ? crm.toUpperCase() : 'CRM'} Connected Successfully!`);
          this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
        } else if (status === 'error') {
          this.toastr.error('Failed to connect to CRM. Please try again.');
          this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
        }

        return this.crmAuthService.getUserConnections();
      }),
      delay(0)
    ).subscribe({
      next: (connections: CrmConnection[]) => {
        this.parseConnections(connections);
        this.isPageLoading = false; // Turn off page loader
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load CRM connections', err);
        this.toastr.error('Could not load your saved connections.');
        this.isPageLoading = false; // Turn off page loader even on error
        this.cdr.detectChanges();
      }
    });
  }

  loadActiveConnections() {
    this.isPageLoading = true;
    this.crmAuthService.getUserConnections().pipe(
      delay(0)
    ).subscribe({
      next: (connections: CrmConnection[]) => {
        this.parseConnections(connections);
        this.isPageLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.isPageLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private parseConnections(connections: CrmConnection[]) {
    let nextSourceConnected = false;
    let nextTargetConnected = false;
    let nextSelectedSource = '';
    let nextSelectedTarget = '';
    let nextSourceUrl = '';
    let nextTargetUrl = '';

    connections.forEach(conn => {
      if (conn.connection_role === 'source') {
        nextSelectedSource = conn.crm_type;
        nextSourceConnected = true;
        
        if (conn.crm_type === 'salesforce') {
          nextSourceUrl = conn.instance_url || '';
          if (conn.environment) this.sourceSalesforceEnv = conn.environment;
        } else if (conn.crm_type === 'zoho') {
          nextSourceUrl = conn.api_domain || '';
          if (conn.region) this.sourceZohoRegion = conn.region;
        } else if (conn.crm_type === 'zendesk') {
          nextSourceUrl = conn.subdomain ? `https://${conn.subdomain}.zendesk.com` : '';
          if (conn.subdomain) this.sourceZendeskSubdomain = conn.subdomain;
        }
      } 
      else if (conn.connection_role === 'target') {
        nextSelectedTarget = conn.crm_type;
        nextTargetConnected = true;
        
        if (conn.crm_type === 'salesforce') {
          nextTargetUrl = conn.instance_url || '';
          if (conn.environment) this.targetSalesforceEnv = conn.environment;
        } else if (conn.crm_type === 'zoho') {
          nextTargetUrl = conn.api_domain || '';
          if (conn.region) this.targetZohoRegion = conn.region;
        } else if (conn.crm_type === 'zendesk') {
          nextTargetUrl = conn.subdomain ? `https://${conn.subdomain}.zendesk.com` : '';
          if (conn.subdomain) this.targetZendeskSubdomain = conn.subdomain;
        }
      }
    });

    this.selectedSource = nextSelectedSource;
    this.selectedTarget = nextSelectedTarget;
    this.isSourceConnected = nextSourceConnected;
    this.isTargetConnected = nextTargetConnected;
    this.sourceInstanceUrl = nextSourceUrl;
    this.targetInstanceUrl = nextTargetUrl;

    if (this.selectedSource) {
      localStorage.setItem('source_crm_slot', this.selectedSource);
    } else {
      localStorage.removeItem('source_crm_slot');
    }

    if (this.selectedTarget) {
      localStorage.setItem('target_crm_slot', this.selectedTarget);
    } else {
      localStorage.removeItem('target_crm_slot');
    }

    // Turn off connecting spinners if they came back from OAuth
    this.isSourceConnecting = false;
    this.isTargetConnecting = false;

    this.cdr.detectChanges();
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

    if (side === 'source') {
      this.isSourceConnecting = true;
    } else {
      this.isTargetConnecting = true;
    }

    this.crmAuthService.connectCrm(selectedCrmId, side, subdomain, region, env);
    
    // Safety fallback: if redirect fails or gets blocked, reset loaders after 5s
    setTimeout(() => {
      this.isSourceConnecting = false;
      this.isTargetConnecting = false;
      this.cdr.detectChanges();
    }, 5000);
  }

  disconnectCRM(side: 'source' | 'target') {
    this.isPageLoading = true;
    
    this.crmAuthService.disconnectCrm(side).subscribe({
      next: () => {
        this.toastr.success(`${side.toUpperCase()} disconnected successfully.`);
        
        if (side === 'source') {
          this.isSourceConnected = false;
          this.selectedSource = '';
          this.sourceInstanceUrl = '';

          localStorage.removeItem('source_crm_slot');
        } else {
          this.isTargetConnected = false;
          this.selectedTarget = '';
          this.targetInstanceUrl = '';
          
          localStorage.removeItem('target_crm_slot');
        }
        
        window.dispatchEvent(new Event('connections-updated'));
        
        this.isPageLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.toastr.error('Failed to disconnect. Please try again.');
        this.isPageLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  goToMappingPage(method: 'api' | 'csv') {
    localStorage.setItem('target_crm_slot', this.selectedTarget);

    if (method === 'api') {
      if (!this.isSourceConnected || !this.isTargetConnected) return;
      localStorage.setItem('source_crm_slot', this.selectedSource);
      
      this.router.navigate(['/api-mapping'], {
        state: { sourceCrm: this.selectedSource, targetCrm: this.selectedTarget }
      });
      
    } else if (method === 'csv') {
      if (!this.isTargetConnected) return;
      localStorage.setItem('source_crm_slot', 'csv'); // Force the context to CSV
      
      this.router.navigate(['/data-validation'], {
        state: { sourceCrm: 'csv', targetCrm: this.selectedTarget }
      });
    }
  }

  ngOnDestroy() {
    if (this.authSubscription) {
      this.authSubscription.unsubscribe();
    }
  }
}