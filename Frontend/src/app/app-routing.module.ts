import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdminComponent } from './theme/layout/admin/admin.component';
import { GuestComponent } from './theme/layout/guest/guest.component';
import { authGuard } from 'src/app/demo/AuthGuard/auth.guard';
import { MigrationTool } from './migration-tool/migration-tool';

export const routes: Routes = [
  {
    path: '',
    component: GuestComponent,
    children: [
      {
        path: '',
        redirectTo: 'login', // Redirect empty guest path to login
        pathMatch: 'full'
      },
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
        path: 'dashboard',
        loadComponent: () => import('./demo/dashboard/default/default.component').then((c) => c.DefaultComponent)
      },
      {
        path: 'migrate',
        component: MigrationTool
      },
      // ... rest of your admin routes
    ]
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
