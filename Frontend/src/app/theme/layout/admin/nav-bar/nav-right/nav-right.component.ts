import { Component, OnInit, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { SharedModule } from 'src/app/theme/shared/shared.module';
import { AuthService } from 'src/app/demo/Services/auth.service';

@Component({
  selector: 'app-nav-right',
  standalone: true,
  imports: [RouterModule, SharedModule, CommonModule],
  templateUrl: './nav-right.component.html',
  styleUrls: ['./nav-right.component.scss']
})
export class NavRightComponent implements OnInit, OnDestroy {
  currentUserName: string | null = null;
  currentUserEmail: string | null = null;
  private routerSub!: Subscription;

  constructor(
    private cdr: ChangeDetectorRef,
    private router: Router,
    private authService: AuthService
  ) {}

  ngOnInit(): void {
    this.loadCurrentUser();

    this.routerSub = this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe(() => {
      this.loadCurrentUser();
    });
  }

  ngOnDestroy(): void {
    if (this.routerSub) {
      this.routerSub.unsubscribe();
    }
  }

  loadCurrentUser(): void {
    this.currentUserName = this.authService.currentUserName();
    this.currentUserEmail = this.authService.currentUserEmail();
    this.cdr.detectChanges();
  }

  getDisplayName(fullName: string | null): string {
    if (!fullName) {
      return 'Guest';
    }

    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 0) {
      return 'Guest';
    }
    if (parts.length === 1) {
      return parts[0];
    }

    return `${parts[0]} ${parts[parts.length - 1]}`;
  }

  onLogout(): void {
    this.authService.logout();
  }
}