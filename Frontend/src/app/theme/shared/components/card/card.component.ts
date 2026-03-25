import { Component, input } from '@angular/core';

@Component({
  selector: 'app-card',
  standalone: true, // (Assuming standalone based on 'imports: []')
  templateUrl: './card.component.html',
  styleUrl: './card.component.scss'
})
export class CardComponent {
  // Initialize as Signal inputs
  cardTitle = input<string>(''); 
  customHeader = input<boolean>(false);
}