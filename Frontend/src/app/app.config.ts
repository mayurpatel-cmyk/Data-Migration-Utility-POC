import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http'; // 1. Added withInterceptors
import { routes } from './app-routing.module';
import { provideToastr } from 'ngx-toastr';
import { provideMonacoEditor } from 'ngx-monaco-editor-v2';

// 2. Import your interceptor (Double-check this relative path matches your folder structure!)
import { authInterceptor } from './demo/Services/auth.interceptor'; 

export const appConfig: ApplicationConfig = {
   providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideMonacoEditor({
      baseUrl: '/assets/monaco/vs' 
    }),
    
    // 3. Register the interceptor here
    provideHttpClient(
      withInterceptors([authInterceptor])
    ),
    
    provideToastr({   
      timeOut: 3000,
      positionClass: 'toast-top-right',
      preventDuplicates: true,
    }),
  ]
};