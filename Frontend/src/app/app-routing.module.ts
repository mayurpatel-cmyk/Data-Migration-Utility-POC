import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdminComponent } from './theme/layout/admin/admin.component';
import { GuestComponent } from './theme/layout/guest/guest.component';
import { authGuard } from 'src/app/demo/AuthGuard/auth.guard';
import { ConnectionComponent } from './demo/dashboard/Connection/connection.component';

export const routes: Routes = [
//         {
//   path: 'api-mapping', 
//   loadComponent: () => import('./demo/dashboard/API-mapping/API-mapping.component').then((c) => c.ApiMappingComponent)
// },
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
      },
{
        path: 'data-validation',
        // Make sure this path exactly matches where you saved the validation component
        loadComponent: () => import('./demo/dashboard/DataValidation/data-validation.component').then(c => c.DataValidationComponent)
      },
{
        path: 'connection',
        loadComponent: () => import('./demo/dashboard/Connection/connection.component').then(c => c.ConnectionComponent)
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