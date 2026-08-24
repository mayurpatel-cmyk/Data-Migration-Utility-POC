import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdminComponent } from './theme/layout/admin/admin.component';
import { GuestComponent } from './theme/layout/guest/guest.component';
import { authGuard } from 'src/app/demo/AuthGuard/auth.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full'
  },

  {
    path: '',
    component: GuestComponent,
    children: [
      {
        path: 'login',
        loadComponent: () => import('./demo/pages/authentication/login/login.component').then((c) => c.LoginComponent)
      }
    ]
  },

  {
    path: '',
    component: AdminComponent,
    canActivate: [authGuard],
    children: [
      {
        path: 'data-import',
        loadComponent: () => import('./demo/dashboard/default/default.component').then((c) => c.DefaultComponent)
      },
      {
        path: 'data-validation',
        loadComponent: () => import('./demo/dashboard/DataValidation/data-validation.component').then((c) => c.DataValidationComponent)
      },
      {
        path: 'connection',
        loadComponent: () => import('./demo/dashboard/Connection/connection.component').then((c) => c.ConnectionComponent)
      },
      {
        path: 'migration-docs',
        loadComponent: () => import('./demo/dashboard/migration-docs/migration-docs.component').then((c) => c.MigrationDocsComponent)
      },
      {
        path: 'migration-history',
        loadComponent: () => import('./demo/dashboard/Migration-history/migration-history.component').then((c) => c.MigrationHistoryComponent)
      }
    ]
  },

  {
    path: 'api-mapping',
    canActivate: [authGuard],
    loadComponent: () => import('./demo/dashboard/API-mapping/API-mapping.component').then((c) => c.ApiMappingComponent)
  },

  {
    path: '**',
    redirectTo: 'login'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}