import { Component, ViewEncapsulation, input, inject } from '@angular/core';
import { Router, NavigationStart, NavigationEnd, NavigationCancel, NavigationError } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { Spinkit } from './spinkits';

@Component({
  selector: 'app-spinner',
  templateUrl: './spinner.component.html',
  styleUrls: ['./spinner.component.scss', './spinkit-css/sk-line-material.scss'],
  encapsulation: ViewEncapsulation.None
})
export class SpinnerComponent {
  private router = inject(Router);

  // public props
  Spinkit = Spinkit;
  backgroundColor = input('#2689E2');
  spinner = input(Spinkit.skLine);

  // Convert router events to a reactive Signal
  isSpinnerVisible = toSignal(
    this.router.events.pipe(
      filter(event => 
        event instanceof NavigationStart || 
        event instanceof NavigationEnd || 
        event instanceof NavigationCancel || 
        event instanceof NavigationError
      ),
      map(event => event instanceof NavigationStart), // true if starting, false otherwise
      startWith(true) // Initial state
    )
  );
}