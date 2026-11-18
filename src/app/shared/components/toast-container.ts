import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {MatIconModule} from '@angular/material/icon';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-toast-container',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <div
      class="fixed bottom-4 right-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2.5 safe-area-bottom"
      aria-live="polite"
      aria-atomic="true"
    >
      @for (toast of toastService.toasts(); track toast.id) {
        <div
          class="flex items-start gap-3 rounded-xl border bg-white p-3.5 shadow-md transition-all"
          [class.border-emerald-200]="toast.type === 'success'"
          [class.border-red-200]="toast.type === 'error'"
          [class.border-amber-200]="toast.type === 'warning'"
          [class.border-slate-200]="toast.type === 'info'"
          role="status"
        >
          <mat-icon
            class="mt-0.5 shrink-0 text-[20px]!"
            [class.text-emerald-600]="toast.type === 'success'"
            [class.text-red-600]="toast.type === 'error'"
            [class.text-amber-600]="toast.type === 'warning'"
            [class.text-slate-700]="toast.type === 'info'"
          >
            @switch (toast.type) {
              @case ('success') { check_circle }
              @case ('error') { error }
              @case ('warning') { warning }
              @default { notifications }
            }
          </mat-icon>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-slate-900">{{ toast.title }}</p>
            <p class="mt-0.5 text-xs leading-relaxed text-slate-600 break-words">{{ toast.message }}</p>
          </div>
          <button
            type="button"
            (click)="toastService.dismiss(toast.id)"
            class="touch-target -mr-1.5 -mt-1.5 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-slate-900"
            aria-label="Dismiss notification"
          >
            <mat-icon class="text-[18px]!">close</mat-icon>
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastContainer {
  protected readonly toastService = inject(ToastService);
}
