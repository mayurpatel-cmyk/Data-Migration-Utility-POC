import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MigrationTool } from './migration-tool';

describe('MigrationTool', () => {
  let component: MigrationTool;
  let fixture: ComponentFixture<MigrationTool>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MigrationTool]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MigrationTool);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
