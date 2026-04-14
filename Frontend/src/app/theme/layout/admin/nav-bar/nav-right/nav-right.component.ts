import { Component, OnInit, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { HttpClient } from '@angular/common/http';
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
    private http: HttpClient, 
    private cdr: ChangeDetectorRef,
    private router: Router // <-- Inject the Router
  ) {}

  ngOnInit(): void {
    // 1. Fetch data on initial load
    this.getUserData();

    // 2. Listen for route changes (like coming back from the login page)
    // This forces the navbar to re-check local storage and fetch the user again.
    this.routerSub = this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe(() => {
      // Only re-fetch if we don't already have the user loaded
      if (!this.currentUser) {
         this.getUserData();
      }
    });
  }

  ngOnDestroy(): void {
    // Clean up the subscription to prevent memory leaks
    if (this.routerSub) {
      this.routerSub.unsubscribe();
    }
  }

  getUserData(): void {
  // Read directly from the new local storage keys
  const accessToken = localStorage.getItem('sf_token') || '';
  const instanceUrl = localStorage.getItem('sf_instance_url') || '';
  
  // We will check for accessToken instead of email to trigger the API call,
  // since the token is what we actually get back from the OAuth login.
  if (accessToken && instanceUrl) {
    this.isLoading = true;

    this.http.get<any>('http://localhost:3000/api/sf/user-info', {
      headers: {
        'instanceurl': instanceUrl, 
        'accesstoken': accessToken,
        'user-email': '' // Sending blank if email isn't stored
      }
    }).subscribe({
      next: (response) => {
        if (response.success && response.data) {
          this.currentUser = response.data;
        }
        this.isLoading = false;
        this.cdr.detectChanges(); 
      },
      error: (error) => {
        console.error('Error fetching user data', error);
        this.isLoading = false;
        this.cdr.detectChanges(); 
      }
    });
  } else {
    console.warn('No Salesforce token found, skipping user info API call.');
    this.isLoading = false;
    this.cdr.detectChanges();
  }
}
}