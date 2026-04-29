// Angular import
import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

// project import
import { SpinnerComponent } from './theme/shared/components/spinner/spinner.component';
import { AuthService } from '../app/demo/Services/auth.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  imports: [RouterOutlet, SpinnerComponent]
})
export class AppComponent {
  title = 'SureShift';
  public authService = inject(AuthService);
  onLogout() {
    this.authService.logout();
  }
}
