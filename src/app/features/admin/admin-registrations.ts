import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormBuilder, ReactiveFormsModule} from '@angular/forms';
import {ActivatedRoute} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {AuthService} from '../../core/services/auth.service';
import {ToastService} from '../../core/services/toast.service';
import {QRCodeItem, UserRecord} from '../../core/models/types';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-admin-registrations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ReactiveFormsModule, MatIconModule, StatusText],
  template: `
    <div class="space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Registration Management</h1>
          <p class="mt-1 text-sm text-slate-600">
            Review applications, inspect identity documents, approve with atomic QR issuance, reject, or request resubmission.
          </p>
        </div>
      </div>

      <!-- Segmented Status Tabs -->
      <div class="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1.5">
        @for (tab of statusTabs; track tab.value) {
          <button
            type="button"
            (click)="setStatusFilter(tab.value)"
            class="touch-target rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap"
            [class.bg-[#0F172A]]="activeStatus() === tab.value"
            [class.text-white]="activeStatus() === tab.value"
            [class.text-slate-600]="activeStatus() !== tab.value"
            [class.hover:bg-slate-100]="activeStatus() !== tab.value"
          >
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Filter Bar -->
      <form [formGroup]="filterForm" (ngSubmit)="loadRegistrations(1)" class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div class="lg:col-span-2">
          <label for="f-search" class="block text-[11px] font-semibold text-slate-500 mb-1">Search</label>
          <input
            id="f-search"
            type="text"
            formControlName="search"
            placeholder="Name, Reg ID, email, mobile..."
            class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs"
          />
        </div>
        <div>
          <label for="f-state" class="block text-[11px] font-semibold text-slate-500 mb-1">State</label>
          <select id="f-state" formControlName="state" class="w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs">
            <option value="">All States</option>
            @for (st of availableStates(); track st) {
              <option [value]="st">{{ st }}</option>
            }
          </select>
        </div>
        <div>
          <label for="f-city" class="block text-[11px] font-semibold text-slate-500 mb-1">City</label>
          <select id="f-city" formControlName="city" class="w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs">
            <option value="">All Cities</option>
            @for (ct of availableCities(); track ct) {
              <option [value]="ct">{{ ct }}</option>
            }
          </select>
        </div>
        <div>
          <label for="f-from" class="block text-[11px] font-semibold text-slate-500 mb-1">From Date</label>
          <input id="f-from" type="date" formControlName="dateFrom" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
        </div>
        <div class="flex items-end gap-2">
          <button
            type="submit"
            class="touch-target flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#0F172A] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
          >
            <mat-icon class="text-[16px]!">filter_list</mat-icon>
            <span>Apply</span>
          </button>
          <button
            type="button"
            (click)="resetFilters()"
            class="touch-target rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Reset
          </button>
        </div>
      </form>

      <!-- Responsive Mobile Cards (< md) -->
      <div class="grid grid-cols-1 gap-3 md:hidden">
        @for (item of items(); track item.id) {
          <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <img
                  [src]="item.profile_photo_url"
                  [alt]="item.full_name"
                  class="h-11 w-11 shrink-0 rounded-lg object-cover border border-slate-200"
                  referrerpolicy="no-referrer"
                />
                <div class="min-w-0">
                  <p class="truncate text-sm font-bold text-slate-900">{{ item.full_name }}</p>
                  <p class="font-mono text-xs text-slate-500 tabular-nums">{{ item.registration_id }}</p>
                </div>
              </div>
              <app-status-text [status]="item.approval_status" />
            </div>
            <div class="text-xs text-slate-600 space-y-1">
              <p class="truncate">{{ item.email }} · {{ item.mobile }}</p>
              <p>{{ item.city }}, {{ item.state }} · {{ item.created_at | date: 'mediumDate' }}</p>
            </div>
            <button
              type="button"
              (click)="openDetail(item.id)"
              class="touch-target w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100"
            >
              <mat-icon class="text-[16px]!">visibility</mat-icon>
              <span>Inspect &amp; Review</span>
            </button>
          </div>
        }
      </div>

      <!-- Desktop/Tablet Data Table (>= md) -->
      <div class="hidden md:block rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                <th class="px-4 py-3">Applicant</th>
                <th class="px-4 py-3">Registration ID</th>
                <th class="px-4 py-3">Location</th>
                <th class="px-4 py-3">Submitted</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3">QR Status</th>
                <th class="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 text-xs">
              @for (item of items(); track item.id) {
                <tr class="hover:bg-slate-50">
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-3">
                      <img
                        [src]="item.profile_photo_url"
                        [alt]="item.full_name"
                        class="h-9 w-9 shrink-0 rounded-lg object-cover border border-slate-200"
                        referrerpolicy="no-referrer"
                      />
                      <div>
                        <p class="font-semibold text-slate-900">{{ item.full_name }}</p>
                        <p class="text-[11px] text-slate-500">{{ item.email }}</p>
                      </div>
                    </div>
                  </td>
                  <td class="px-4 py-3 font-mono font-medium text-slate-800 tabular-nums">
                    {{ item.registration_id }}
                  </td>
                  <td class="px-4 py-3 text-slate-700">{{ item.city }}, {{ item.state }}</td>
                  <td class="px-4 py-3 font-mono text-slate-500 tabular-nums">
                    {{ item.created_at | date: 'yyyy-MM-dd' }}
                  </td>
                  <td class="px-4 py-3">
                    <app-status-text [status]="item.approval_status" />
                  </td>
                  <td class="px-4 py-3 font-mono text-[11px] text-slate-600">
                    {{ item.latest_qr_status || 'NONE' }}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <button
                      type="button"
                      (click)="openDetail(item.id)"
                      class="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap"
                    >
                      <mat-icon class="text-[16px]!">open_in_new</mat-icon>
                      <span>Review</span>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      @if (items().length === 0 && !loading()) {
        <div class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No registration records match the selected filters.
        </div>
      }

      <!-- Pagination -->
      @if (total() > pageSize) {
        <div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs">
          <span class="font-mono text-slate-600 tabular-nums">
            Page {{ page() }} · Total {{ total() }} records
          </span>
          <div class="flex gap-2">
            <button
              type="button"
              (click)="loadRegistrations(page() - 1)"
              [disabled]="page() <= 1"
              class="touch-target rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              (click)="loadRegistrations(page() + 1)"
              [disabled]="page() * pageSize >= total()"
              class="touch-target rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      }

      <!-- Application Review Modal / Slide-over -->
      @if (selectedDetail(); as detail) {
        <div class="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/50">
          <div class="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-xl flex flex-col">
            <div class="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <p class="font-mono text-xs font-semibold text-slate-500 tabular-nums">
                  {{ detail.record.registration_id }}
                </p>
                <h2 class="text-lg font-bold text-[#0F172A] font-display">
                  {{ detail.record.full_name }}
                </h2>
              </div>
              <button
                type="button"
                (click)="selectedDetail.set(null)"
                class="touch-target flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close review panel"
              >
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="flex-1 space-y-6 p-5 sm:p-6">
              <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
                <img
                  [src]="detail.record.profile_photo_url"
                  [alt]="detail.record.full_name"
                  class="h-24 w-24 rounded-xl border border-slate-200 object-cover"
                  referrerpolicy="no-referrer"
                />
                <div class="space-y-1.5">
                  <app-status-text [status]="detail.record.approval_status" />
                  <p class="text-xs text-slate-600">{{ detail.record.email }} · {{ detail.record.mobile }}</p>
                  <p class="text-xs text-slate-600">
                    {{ detail.record.address }}, {{ detail.record.city }}, {{ detail.record.district }}, {{ detail.record.state }}, {{ detail.record.country }} {{ detail.record.postal_code }}
                  </p>
                </div>
              </div>

              <!-- Document Preview -->
              <div class="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p class="text-xs font-bold text-slate-800 mb-2">
                  ID Proof Document ({{ detail.record.id_proof_type }})
                </p>
                @if (detail.record.id_proof_url) {
                  @if (isPdfUrl(detail.record.id_proof_url)) {
                    <a
                      [href]="detail.record.id_proof_url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1E3A5F] underline"
                    >
                      <mat-icon class="text-[16px]!">picture_as_pdf</mat-icon>
                      <span>Open Attached PDF Document</span>
                    </a>
                  } @else {
                    <img
                      [src]="detail.record.id_proof_url"
                      alt="Submitted ID Proof"
                      class="max-h-52 rounded-lg border border-slate-200 object-contain bg-white"
                      referrerpolicy="no-referrer"
                    />
                  }
                } @else {
                  <p class="text-xs text-slate-500">No document attached.</p>
                }
              </div>

              <!-- Dynamic Fields -->
              <div>
                <p class="text-xs font-bold text-slate-800 mb-2">Organization &amp; Custom Fields</p>
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
                  @for (entry of objectEntries(detail.record.dynamicFields); track entry[0]) {
                    <div class="rounded-lg border border-slate-200 px-3 py-2">
                      <span class="text-slate-500">{{ formatFieldKey(entry[0]) }}: </span>
                      <span class="font-semibold text-slate-900">{{ entry[1] || 'N/A' }}</span>
                    </div>
                  }
                </div>
              </div>

              <!-- Admin Action Controls -->
              @if (auth.hasPermission('can_approve_registrations')) {
                <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-4">
                  <h3 class="text-sm font-bold text-[#0F172A] font-display">Review Decision</h3>
                  <form [formGroup]="actionForm" class="space-y-3">
                    <div>
                      <label for="action-reason" class="block text-xs font-semibold text-slate-700 mb-1">
                        Decision Note / Rejection Reason / Resubmission Instructions
                      </label>
                      <textarea
                        id="action-reason"
                        rows="2"
                        formControlName="note"
                        placeholder="Required for Rejection or Resubmission requests..."
                        class="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-xs"
                      ></textarea>
                    </div>
                    <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <button
                        type="button"
                        (click)="approve(detail.record.id)"
                        [disabled]="processingAction()"
                        class="touch-target inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                      >
                        <mat-icon class="text-[18px]!">check_circle</mat-icon>
                        <span>Approve &amp; Issue QR</span>
                      </button>
                      <button
                        type="button"
                        (click)="requestResubmission(detail.record.id)"
                        [disabled]="processingAction()"
                        class="touch-target inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                      >
                        <mat-icon class="text-[18px]!">edit_note</mat-icon>
                        <span>Request Resubmission</span>
                      </button>
                      <button
                        type="button"
                        (click)="reject(detail.record.id)"
                        [disabled]="processingAction()"
                        class="touch-target inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-700 px-4 py-2 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-50"
                      >
                        <mat-icon class="text-[18px]!">cancel</mat-icon>
                        <span>Reject Application</span>
                      </button>
                    </div>
                  </form>
                </div>
              }

              <!-- Approval History -->
              <div>
                <h3 class="text-xs font-bold text-slate-800 mb-2">Approval History</h3>
                <div class="space-y-2 text-xs">
                  @for (h of detail.history; track h['id']) {
                    <div class="rounded-lg border border-slate-200 px-3 py-2 flex items-center justify-between gap-2">
                      <div>
                        <span class="font-semibold text-slate-900">{{ h['status'] }}</span>
                        <span class="text-slate-500"> · {{ h['notes'] }}</span>
                      </div>
                      <span class="font-mono text-[11px] text-slate-400 tabular-nums">
                        {{ '' + h['submitted_at'] | date: 'short' }}
                      </span>
                    </div>
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class AdminRegistrations implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);

  protected readonly statusTabs = [
    {value: 'ALL', label: 'All Applications'},
    {value: 'PENDING', label: 'Pending'},
    {value: 'APPROVED', label: 'Approved'},
    {value: 'RESUBMISSION_REQUIRED', label: 'Resubmission'},
    {value: 'REJECTED', label: 'Rejected'},
  ];

  protected readonly activeStatus = signal('ALL');
  protected readonly items = signal<UserRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly pageSize = 15;
  protected readonly loading = signal(false);
  protected readonly availableStates = signal<string[]>([]);
  protected readonly availableCities = signal<string[]>([]);

  protected readonly selectedDetail = signal<{
    record: UserRecord;
    history: Record<string, unknown>[];
    qrs: QRCodeItem[];
  } | null>(null);
  protected readonly processingAction = signal(false);

  protected readonly filterForm = this.fb.group({
    search: [''],
    state: [''],
    city: [''],
    dateFrom: [''],
  });

  protected readonly actionForm = this.fb.group({
    note: [''],
  });

  ngOnInit(): void {
    this.route.queryParams.subscribe((params) => {
      const st = params['status'] || 'ALL';
      this.activeStatus.set(st);
      void this.loadRegistrations(1);
    });
  }

  setStatusFilter(status: string): void {
    this.activeStatus.set(status);
    void this.loadRegistrations(1);
  }

  resetFilters(): void {
    this.filterForm.reset({search: '', state: '', city: '', dateFrom: ''});
    void this.loadRegistrations(1);
  }

  async loadRegistrations(targetPage: number): Promise<void> {
    this.loading.set(true);
    try {
      const f = this.filterForm.value;
      const res = await firstValueFrom(
        this.api.getAdminRegistrations({
          status: this.activeStatus(),
          search: f.search || '',
          state: f.state || '',
          city: f.city || '',
          dateFrom: f.dateFrom || '',
          page: targetPage,
          pageSize: this.pageSize,
        }),
      );
      this.items.set(res.items);
      this.total.set(res.total);
      this.page.set(res.page);
      this.availableStates.set(res.filters.states);
      this.availableCities.set(res.filters.cities);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not load registration records.';
      this.toast.error('Load Failed', msg);
    } finally {
      this.loading.set(false);
    }
  }

  async openDetail(id: number): Promise<void> {
    this.actionForm.reset({note: ''});
    try {
      const detail = await firstValueFrom(this.api.getAdminRegistrationDetail(id));
      this.selectedDetail.set(detail);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not load application details.';
      this.toast.error('Error', msg);
    }
  }

  async approve(id: number): Promise<void> {
    this.processingAction.set(true);
    try {
      await firstValueFrom(this.api.approveRegistration(id, String(this.actionForm.value.note || '')));
      this.toast.success('Approved & QR Issued', 'Application approved and cryptographic QR created.');
      await this.openDetail(id);
      await this.loadRegistrations(this.page());
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Approval failed.';
      this.toast.error('Approval Error', msg);
    } finally {
      this.processingAction.set(false);
    }
  }

  async reject(id: number): Promise<void> {
    const reason = String(this.actionForm.value.note || '').trim();
    if (!reason) {
      this.toast.warning('Reason Required', 'Enter a rejection reason in the note box first.');
      return;
    }
    this.processingAction.set(true);
    try {
      await firstValueFrom(this.api.rejectRegistration(id, reason));
      this.toast.info('Application Rejected', 'Applicant has been notified.');
      await this.openDetail(id);
      await this.loadRegistrations(this.page());
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Rejection failed.';
      this.toast.error('Error', msg);
    } finally {
      this.processingAction.set(false);
    }
  }

  async requestResubmission(id: number): Promise<void> {
    const note = String(this.actionForm.value.note || '').trim();
    if (!note) {
      this.toast.warning('Instructions Required', 'Enter correction instructions for the applicant.');
      return;
    }
    this.processingAction.set(true);
    try {
      await firstValueFrom(this.api.requestResubmission(id, note));
      this.toast.info('Resubmission Requested', 'Applicant notified to update and resubmit.');
      await this.openDetail(id);
      await this.loadRegistrations(this.page());
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Request failed.';
      this.toast.error('Error', msg);
    } finally {
      this.processingAction.set(false);
    }
  }

  objectEntries(obj: Record<string, string>): [string, string][] {
    return Object.entries(obj || {});
  }

  isPdfUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('.pdf') || lower.startsWith('data:application/pdf');
  }

  formatFieldKey(key: string): string {
    return key
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
}
