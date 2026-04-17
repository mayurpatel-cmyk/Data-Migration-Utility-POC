import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdminComponent } from './theme/layout/admin/admin.component';
import { GuestComponent } from './theme/layout/guest/guest.component';
import { authGuard } from 'src/app/demo/AuthGuard/auth.guard';

export const routes: Routes = [
  {
    path: '',
    component: AdminComponent,
    canActivate: [authGuard],
    children: [
      {
        // We removed the 'dashboard' nesting.
        // Now it matches the URL from your navigation menu directly.
        path: 'data-import',
        loadComponent: () => import('./demo/dashboard/default/default.component').then((c) => c.DefaultComponent)
      },
      {
        // Optional: Redirect the base admin path to your import page
        path: '',
        redirectTo: 'data-import',
        pathMatch: 'full'
      }
    ]
  },
  {
    path: '',
    component: GuestComponent,
    children: [
      {
        path: '',
        redirectTo: 'login',
        pathMatch: 'full'
      },
      {
        path: 'login',
        loadComponent: () => import('./demo/pages/authentication/login/login.component').then((c) => c.LoginComponent)
      }
    ]
  }

];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}