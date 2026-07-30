import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardComponent } from 'src/app/theme/shared/components/card/card.component';

@Component({
  selector: 'app-migration-docs',
  standalone: true,
  imports: [CommonModule, CardComponent],
  templateUrl: './migration-docs.component.html',
  styleUrls: []
})
export class MigrationDocsComponent {
  activeTab: string = 'overview';
  isPrinting: boolean = false; 

  setActiveTab(tabName: string): void {
    this.activeTab = tabName;
  }

  downloadPDF(): void {
    this.isPrinting = true;
    setTimeout(() => {
      window.print();
      this.isPrinting = false;
    }, 150);
  }
}