// Angular Import
import { Component, Input, inject, ChangeDetectorRef } from '@angular/core'; // Added ChangeDetectorRef

import { NavigationEnd, Router, RouterModule, Event } from '@angular/router';
import { Title } from '@angular/platform-browser';

// project import
import { NavigationItem, NavigationItems } from 'src/app/theme/layout/admin/navigation/navigation';
import { SharedModule } from '../../shared.module';

interface titleType {
  // eslint-disable-next-line
  url: string | boolean | any | undefined;
  title: string;
  breadcrumbs: unknown;
  type: string;
}

@Component({
  selector: 'app-breadcrumb',
  imports: [RouterModule, SharedModule],
  templateUrl: './breadcrumbs.component.html',
  styleUrls: ['./breadcrumbs.component.scss']
})
export class BreadcrumbComponent {
  private route = inject(Router);
  private titleService = inject(Title);
  private cdr = inject(ChangeDetectorRef); // <--- 1. Inject ChangeDetectorRef

  // public props
  @Input() type: string;

  navigations: NavigationItem[];
  breadcrumbList: Array<string> = [];
  
  // <--- 2. THE FIX: Initialize this with an empty array instead of leaving it undefined
  navigationList: titleType[] = []; 

  // constructor
  constructor() {
    this.navigations = NavigationItems;
    this.type = 'icon';
    this.setBreadcrumb();
  }

  // public method
  setBreadcrumb() {
    this.route.events.subscribe((router: Event) => {
      if (router instanceof NavigationEnd) {
        const activeLink = router.url;
        const breadcrumbList = this.filterNavigation(this.navigations, activeLink);
        const title = breadcrumbList[breadcrumbList.length - 1]?.title || 'Welcome';
        
        // 3. Update the list and safely trigger change detection
        this.navigationList = breadcrumbList.splice(-2);
        this.titleService.setTitle(title + ' | Data Migration Utility - POC');
        
        this.cdr.detectChanges(); // Tell Angular the breadcrumb data has updated
      }
    });
  }

  filterNavigation(navItems: NavigationItem[], activeLink: string): titleType[] {
    for (const navItem of navItems) {
      if (navItem.type === 'item' && 'url' in navItem && navItem.url === activeLink) {
        return [
          {
            url: 'url' in navItem ? navItem.url : false,
            title: navItem.title,
            breadcrumbs: 'breadcrumbs' in navItem ? navItem.breadcrumbs : true,
            type: navItem.type
          }
        ];
      }
      if ((navItem.type === 'group' || navItem.type === 'collapse') && 'children' in navItem) {
        const breadcrumbList = this.filterNavigation(navItem.children!, activeLink);

        if (breadcrumbList.length > 0) {
          breadcrumbList.unshift({
            url: 'url' in navItem ? navItem.url : false,
            title: navItem.title,
            breadcrumbs: 'breadcrumbs' in navItem ? navItem.breadcrumbs : true,
            type: navItem.type
          });
          return breadcrumbList;
        }
      }
    }
    return [];
  }
}