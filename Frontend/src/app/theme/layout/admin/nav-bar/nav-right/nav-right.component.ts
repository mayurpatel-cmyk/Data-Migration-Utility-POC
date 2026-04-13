// Angular import
import { Component, OnInit,ChangeDetectorRef } from '@angular/core';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http'; // Added HttpClient
import { CommonModule } from '@angular/common'; // Usually needed for async/pipes

// third party import
import { SharedModule } from 'src/app/theme/shared/shared.module';

@Component({
  selector: 'app-nav-right',
  standalone: true,
  imports: [RouterModule, SharedModule, CommonModule],
  templateUrl: './nav-right.component.html',
  styleUrls: ['./nav-right.component.scss']
})
export class NavRightComponent implements OnInit {
  // Variable to hold the fetched user data
  currentUser: any = null; 
  isLoading: boolean = true;

  constructor(private http: HttpClient,private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.getUserData();
  }

getUserData(): void {
    // 1. Get the full JSON string from local storage using your specific Key
    const storageItem = localStorage.getItem('user_data'); 
    let userEmail = '';
    let accessToken = '';
    let instanceUrl = '';

    // 2. If the item exists, parse it and extract the email
    if (storageItem) {
      try {
        const parsedData = JSON.parse(storageItem);
        userEmail = parsedData.email || ''; 
        accessToken = parsedData.accessToken || ''; 
        instanceUrl = parsedData.instanceUrl || '';
      } catch (error) {
        console.error('Failed to parse user data from local storage:', error);
      }
    }

    // 3. If we successfully got the email, make the API call
    if (userEmail) {
      this.http.get<any>('http://localhost:3000/api/sf/user-info', {
        headers: {
          'user-email': userEmail,
      'instanceurl': instanceUrl, 
      'accesstoken': accessToken  
        }
      }).subscribe({
        next: (response) => {
          if (response.success && response.data) {
            this.currentUser = response.data;
          }
          this.isLoading = false;
          setTimeout(() => {
            if (response.success && response.data) {
              this.currentUser = response.data;
            }
            this.isLoading = false;
            this.cdr.detectChanges(); // Force the HTML to update with the new name!
          });
        },
        error: (error) => {
          console.error('Error fetching user data', error);
          this.isLoading = false;
          setTimeout(() => {
            console.error('Error fetching user data', error);
            this.isLoading = false;
            this.cdr.detectChanges();
          });
        }
      });
    } else {
      console.warn('No user email found, skipping API call.');
      this.isLoading = false;
      setTimeout(() => {
        console.warn('No user email found, skipping API call.');
        this.isLoading = false;
        this.cdr.detectChanges();
      });
    }
  }
}