import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {MatIconModule} from '@angular/material/icon';

@Component({
  selector: 'app-status-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <span class="inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap" [class]="colorClass()">
      <mat-icon class="text-[16px]! h-4! w-4! leading-4!">{{ iconName() }}</mat-icon>
      <span>{{ label() }}</span>
    </span>
  `,
})
export class StatusText {
  readonly status = input.required<string>();

  protected readonly label = computed(() => {
    switch (this.status()) {
      case 'APPROVED':
        return 'Verified & Approved';
      case 'PENDING':
        return 'Awaiting Review';
      case 'REJECTED':
        return 'Application Declined';
      case 'RESUBMISSION_REQUIRED':
        return 'Update Requested';
      case 'ACTIVE':
        return 'Active Pass';
      case 'VALID':
        return 'Verified Pass';
      case 'EXPIRED':
        return 'Pass Expired';
      case 'REVOKED':
        return 'Pass Revoked';
      case 'INVALID':
        return 'Unrecognized Code';
      case 'INACTIVE_USER':
        return 'Account Paused';
      case 'UNAPPROVED_USER':
        return 'Pending Approval';
      default:
        return this.status();
    }
  });

  protected readonly iconName = computed(() => {
    switch (this.status()) {
      case 'APPROVED':
      case 'ACTIVE':
      case 'VALID':
        return 'verified';
      case 'PENDING':
        return 'schedule';
      case 'RESUBMISSION_REQUIRED':
        return 'edit_note';
      case 'EXPIRED':
        return 'event_busy';
      case 'REJECTED':
      case 'REVOKED':
      case 'INVALID':
      case 'INACTIVE_USER':
      case 'UNAPPROVED_USER':
        return 'cancel';
      default:
        return 'info';
    }
  });

  protected readonly colorClass = computed(() => {
    switch (this.status()) {
      case 'APPROVED':
      case 'ACTIVE':
      case 'VALID':
        return 'text-emerald-700';
      case 'PENDING':
      case 'EXPIRED':
        return 'text-amber-700';
      case 'RESUBMISSION_REQUIRED':
        return 'text-blue-700';
      case 'REJECTED':
      case 'REVOKED':
      case 'INVALID':
      case 'INACTIVE_USER':
      case 'UNAPPROVED_USER':
        return 'text-red-700';
      default:
        return 'text-slate-700';
    }
  });
}
