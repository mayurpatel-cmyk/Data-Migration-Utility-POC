import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';

export type DocTab = 'overview' | 'specs' | 'salesforce' | 'zendesk' | 'hubspot' | 'zoho' | 'dataprep' | 'faq';

const VALID_TABS: readonly DocTab[] = ['overview', 'specs', 'salesforce', 'zendesk', 'hubspot', 'zoho', 'dataprep', 'faq'];

@Component({
  selector: 'app-migration-docs',
  standalone: true,
  imports: [CommonModule, CardComponent],
  templateUrl: './migration-docs.component.html',
  styleUrls: []
})
export class MigrationDocsComponent implements OnInit, OnDestroy {
  activeTab: DocTab = 'overview';
  isPrinting = false;

  private routeSub?: Subscription;
  private readonly onAfterPrint = () => this.finishPrinting();

  constructor(private route: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    this.routeSub = this.route.queryParamMap.subscribe((params) => {
      const requested = params.get('tab');
      if (requested && this.isValidTab(requested)) {
        this.activeTab = requested;
      }
    });
    window.addEventListener('afterprint', this.onAfterPrint);
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    window.removeEventListener('afterprint', this.onAfterPrint);
  }

  private isValidTab(value: string): value is DocTab {
    return (VALID_TABS as readonly string[]).includes(value);
  }

  setActiveTab(tabName: DocTab): void {
    this.activeTab = tabName;
    // replaceUrl: switching sections isn't a "navigation" worth stacking in
    // browser history -- Back shouldn't have to click through every tab.
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tabName },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  downloadPDF(): void {
    this.isPrinting = true;
    setTimeout(() => window.print(), 150);
    setTimeout(() => this.finishPrinting(), 5000);
  }

  private finishPrinting(): void {
    this.isPrinting = false;
  }
}