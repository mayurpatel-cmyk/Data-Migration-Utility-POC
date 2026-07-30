import { Component, OnInit, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { SharedModule } from 'src/app/theme/shared/shared.module';

@Component({
  selector: 'app-nav-right',
  standalone: true,
  imports: [RouterModule, SharedModule, CommonModule],
  templateUrl: './nav-right.component.html',
  styleUrls: ['./nav-right.component.scss']
})
export class NavRightComponent implements OnInit, OnDestroy {
  currentUser: any = null; 
  isLoading: boolean = true;
  private routerSub!: Subscription;

  constructor(
    private cdr: ChangeDetectorRef,
    private router: Router
  ) {}

  ngOnInit(): void {
    // 1. Fetch data on initial load
    this.getUserData();

    // 2. Listen for route changes (like coming back from the login page)
    this.routerSub = this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe(() => {
      // Re-fetch to ensure navbar is updated after a login event
      this.getUserData();
    });
  }

  ngOnDestroy(): void {
    if (this.routerSub) {
      this.routerSub.unsubscribe();
    }
  }

  getUserData(): void {
    this.isLoading = true;
    
    // Read the user directly from local storage 
    const storedUser = localStorage.getItem('supabase_user');
    
    if (storedUser) {
      try {
        this.currentUser = JSON.parse(storedUser);
      } catch (error) {
        console.error('Failed to parse user data from local storage', error);
        this.currentUser = null;
      }
    } else {
      this.currentUser = null;
    }

    this.isLoading = false;
    this.cdr.detectChanges(); 
  }
}